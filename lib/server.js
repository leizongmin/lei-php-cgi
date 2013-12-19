/**
 * 简单的Web服务器
 *
 * @author Zongmin Lei<leizongmin@gmail.com>
 */

var connect = require('connect');
var php = require('./php');
var debug = require('./debug')('server');


/**
 * 启动服务器
 *
 * @param {String} dir
 * @param {Object} options
 * @return {Object}
 */
function startServer (dir, options) {
  options = options || {};
  options.path = dir;

  var app = connect();

  app.use(function (req, res, next) {
    debug('[%s] %s', req.method, req.url);
    next();
  });

  app.use(php(options));
  app.use(connect.static(dir));

  debug('start server: wwwroot=%s', dir);

  return app;
}

module.exports = startServer;