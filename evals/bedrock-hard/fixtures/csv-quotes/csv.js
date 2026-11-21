// parseLine splits one CSV line into fields. It must support quoted fields
// containing commas and doubled quotes ("" inside quotes means one quote).
module.exports = function parseLine(line) {
	return line.split(",");
};
