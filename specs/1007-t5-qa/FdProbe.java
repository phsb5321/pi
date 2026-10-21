import java.lang.instrument.Instrumentation;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.HexFormat;

public class FdProbe {
    public static void premain(String arg, Instrumentation ignored) throws Exception {
        String[] parts = arg.split(",");
        byte[] settings = Files.readAllBytes(Path.of("/proc/self/fd/" + parts[0]));
        String text = new String(settings, java.nio.charset.StandardCharsets.UTF_8);
        String secret = text.lines().filter(s -> s.startsWith("sonar.token=")).findFirst().orElseThrow().substring(12);
        if (!secret.startsWith("FAKE_ONLY_")) throw new IllegalStateException("Fixture refuses real credentials");
        if (System.getenv().values().stream().anyMatch(s -> s.contains(secret)) ||
            String.join(" ", ProcessHandle.current().info().arguments().orElse(new String[0])).contains(secret))
            throw new IllegalStateException("Credential exposure");
        System.out.println("FD_OK_SHA256=" + HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(settings)));
        // Deliberately span OS writes; Python must redact before persisting output.
        for (byte b : secret.getBytes(java.nio.charset.StandardCharsets.UTF_8)) {
            System.out.write(b); System.out.flush();
        }
        System.out.println(" " + Base64.getEncoder().encodeToString((secret + ":").getBytes()));
        if (parts[1].equals("fail")) { System.err.println(secret); System.exit(23); }
        if (parts[1].equals("timeout")) Thread.sleep(30000);
    }
}
