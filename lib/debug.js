/**
 * 调试输出
 *
 * @author Zongmin Lei<leizongmin@gmail.com>
 */

var debug = require('debug');

module.exports = function (str) {
  return debug('lei-php-cgi:' + str);
};
