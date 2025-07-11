const ti = require('technicalindicators');

function getSMA(data, period) {
  return ti.SMA.calculate({ period, values: data });
}

module.exports = { getSMA };