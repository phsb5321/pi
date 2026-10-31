// Sum of the integers in the inclusive range [from, to]. Empty when from > to.
export function sumRange(from, to) {
	let total = 0;
	for (let i = from; i < to; i++) total += i;
	return total;
}
