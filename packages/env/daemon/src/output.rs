//! The single writer of stdout. Control frames (results, errors, pings, watch events) always go before bulk command
//! output, so a slow link delays output but never a cancel's result or a ping. Bulk output is bounded: readers of
//! commands without an output window wait while too much of it is unsent, which slows the command down like a full
//! pipe would.

use crate::frame::{self, Frame};
use std::collections::VecDeque;
use std::io::Write;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

/// Unsent bulk bytes above which unwindowed command output waits.
const BULK_LIMIT: usize = 4 * 1024 * 1024;

#[derive(Default)]
struct Queues {
    control: VecDeque<Frame>,
    bulk: VecDeque<(Frame, Option<Arc<AtomicUsize>>)>,
    bulk_bytes: usize,
    closed: bool,
}

#[derive(Default)]
pub struct Output {
    queues: Mutex<Queues>,
    /// Signalled when a frame is queued or the writer stops.
    queued: Condvar,
    /// Signalled when bulk bytes were written.
    drained: Condvar,
}

impl Output {
    pub fn control(&self, frame: Frame) {
        let mut queues = self.queues.lock().unwrap();
        queues.control.push_back(frame);
        self.queued.notify_one();
    }

    /// Queue bulk output; `unsent` counts this sender's frames until they are written.
    pub fn bulk(&self, frame: Frame, unsent: Option<Arc<AtomicUsize>>) {
        let mut queues = self.queues.lock().unwrap();
        queues.bulk_bytes += frame.payload.len();
        if let Some(counter) = &unsent {
            counter.fetch_add(1, Ordering::SeqCst);
        }
        queues.bulk.push_back((frame, unsent));
        self.queued.notify_one();
    }

    /// Wait while more than the bulk limit is unsent, unless `stop` is set.
    pub fn wait_for_room(&self, stop: &AtomicBool) {
        let mut queues = self.queues.lock().unwrap();
        while queues.bulk_bytes > BULK_LIMIT && !queues.closed && !stop.load(Ordering::SeqCst) {
            queues = self
                .drained
                .wait_timeout(queues, Duration::from_millis(100))
                .unwrap()
                .0;
        }
    }

    /// Keep a request's result behind its output, without delaying unrelated control frames.
    pub fn wait_until_sent(&self, unsent: &AtomicUsize, cancelled: &AtomicBool) {
        let mut queues = self.queues.lock().unwrap();
        while unsent.load(Ordering::SeqCst) > 0
            && !queues.closed
            && !cancelled.load(Ordering::SeqCst)
        {
            queues = self
                .drained
                .wait_timeout(queues, Duration::from_millis(100))
                .unwrap()
                .0;
        }
    }

    pub fn close(&self) {
        let mut queues = self.queues.lock().unwrap();
        queues.closed = true;
        self.queued.notify_all();
        self.drained.notify_all();
    }

    /// Write frames to `writer` until closed or a write fails.
    pub fn run(&self, writer: &mut impl Write) {
        loop {
            let (frame, unsent) = {
                let mut queues = self.queues.lock().unwrap();
                loop {
                    if let Some(frame) = queues.control.pop_front() {
                        break (frame, None);
                    }
                    if let Some((frame, unsent)) = queues.bulk.pop_front() {
                        queues.bulk_bytes -= frame.payload.len();
                        break (frame, unsent);
                    }
                    if queues.closed {
                        return;
                    }
                    queues = self.queued.wait(queues).unwrap();
                }
            };
            let failed = frame::write_frame(writer, &frame).is_err();
            if let Some(counter) = unsent {
                let _queues = self.queues.lock().unwrap();
                counter.fetch_sub(1, Ordering::SeqCst);
            }
            self.drained.notify_all();
            if failed {
                self.close();
                return;
            }
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::exec::Control;
    use crate::process::{self, ProcessRequest};
    use serde_json::json;
    use std::sync::mpsc;

    #[test]
    fn closed_link_releases_output_waiter() {
        let output = Output::default();
        let unsent = Arc::new(AtomicUsize::new(0));
        output.bulk(
            Frame::with_payload(frame::EVENT, 7, json!({}), vec![1]),
            Some(unsent.clone()),
        );
        output.close();
        output.wait_until_sent(&unsent, &AtomicBool::new(false));
        assert_eq!(unsent.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn cancellation_releases_an_output_waiter_without_a_link_writer() {
        let output = Arc::new(Output::default());
        let unsent = Arc::new(AtomicUsize::new(1));
        let cancelled = Arc::new(AtomicBool::new(false));
        let (entered, entry) = mpsc::channel();
        let (finished, result) = mpsc::channel();
        let worker_output = output.clone();
        let worker_cancelled = cancelled.clone();
        let waiter = std::thread::spawn(move || {
            entered.send(()).unwrap();
            worker_output.wait_until_sent(&unsent, &worker_cancelled);
            finished.send(()).unwrap();
        });
        entry.recv_timeout(Duration::from_secs(5)).unwrap();
        cancelled.store(true, Ordering::SeqCst);
        // No queued/drained notification accompanies native request cancellation.
        let completed = result.recv_timeout(Duration::from_secs(1));
        output.close();
        waiter.join().unwrap();
        completed.unwrap();
    }

    #[test]
    fn process_exit_waits_for_queued_output() {
        let output = Arc::new(Output::default());
        let worker_output = output.clone();
        let (finished, result) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            let request = ProcessRequest::from_json(&json!({
                "argv": ["/bin/sh", "-c", "printf complete"],
                "cwd": std::env::current_dir().unwrap().to_str().unwrap()
            }))
            .unwrap();
            let outcome = process::run(
                7,
                request,
                &worker_output,
                &Control::default(),
                &Default::default(),
                &Default::default(),
            );
            finished.send(outcome).unwrap();
        });
        // Deliberately withhold the link writer after the process produced output.
        let mut queues = output.queues.lock().unwrap();
        while queues.bulk.is_empty() {
            let (next, timeout) = output
                .queued
                .wait_timeout(queues, Duration::from_secs(5))
                .unwrap();
            queues = next;
            assert!(!timeout.timed_out(), "process produced no output");
        }
        drop(queues);
        let premature = result.recv_timeout(Duration::from_millis(100));
        let writer_output = output.clone();
        let writer = std::thread::spawn(move || {
            let mut bytes = Vec::new();
            writer_output.run(&mut bytes);
            bytes
        });
        let overtook = premature.is_ok();
        let outcome = match premature {
            Ok(outcome) => outcome,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                result.recv_timeout(Duration::from_secs(5)).unwrap()
            }
            Err(error) => panic!("{error}"),
        };
        output.close();
        worker.join().unwrap();
        let bytes = writer.join().unwrap();
        assert_eq!(outcome.unwrap()["exitCode"], 0);
        assert!(!overtook, "process exit overtook queued output");
        let mut input = bytes.as_slice();
        let mut payload = Vec::new();
        while let Some(frame) = frame::read_frame(&mut input).unwrap() {
            payload.extend(frame.payload);
        }
        assert_eq!(payload, b"complete");
    }
}
