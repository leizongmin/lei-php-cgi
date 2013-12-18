/**
 * 处理PHP请求
 *
 * @author Zongmin Lei<leizongmin@gmail.com>
 */

var path = require('path');
var fs = require('fs');
var uuid = require('uuid');
var CGI = require('./cgi');
var debug = require('./debug')('php');


/**
 * 填充默认配置信息
 *
 * @param {Object} options
 * @return {Object}
 */
function fillDefaultOptions (options) {
  options = options || {};
  options.bin = options.bin || 'php-cgi';
  options.path = options.path || process.cwd();
  options.ini = options.ini || false;
  options.process = options.process || {};
  options.process.limit = options.process.limit || 20;
  options.process.timeout = options.process.timeout || 60000;
  options.queue = options.queue || {};
  options.queue.limit = options.queue.limit || 200;
  options.queue.timeout = options.queue.timeout || 600000;
  return options;
}

/**
 * 根据URL来获取php文件名
 *
 * @param {String} url
 * @return {String}
 */
function getPHPFileName (url) {
  var i = url.indexOf('.php');
  if (i === -1) return;
  if (url.slice(i) === '.php') return url;
  var s = url.slice(i, i + 5);
  if (s === '.php?' || s === '.php/') return url.slice(0, i + 4);
};

/**
 * 初始化中间件
 *
 * @param {Object} options
 *   - {String} bin    php-cgi可执行文件路径，默认为php-cgi
 *   - {String} path   PHP文件目录，默认为当前运行目录
 *   - {String} ini    php.ini文件所在的目录或者文件名
 *   - {Object} process
 *     - {Number} limit   最大同时执行进程数量，默认为20，超过此数量时将加入等待队列
 *     - {Number} timeout 进程最长执行时间，默认为60000ms，超过此时间将自动杀死进程
 *   - {Object} queue
 *     - {Number} limit   最大等待队列，默认为200，超过此数量时将直接返回Server Busy
 *     - {Number} timeout 队列最长等待时间，默认为60000ms，超过此时间将直接返回Server Busy
 * @return {Function}
 */
function initMiddleware (options) {
  options = fillDefaultOptions(options);

  var args = [];
  if (options.ini) {
    args.push('-c');
    args.push(options.ini);
  }
  var cgi = new CGI(options.bin, {
    DOCUMENT_ROOT: options.path
  }, args);

  var queue = new RequestQueue(cgi, options);

  return function (req, res, next) {

    req.pause();
    function notHandle () {
      debug('not handle request: %s', req.url);
      req.resume();
      next();
    }

    // 仅处理后缀为.php的请求
    var f = getPHPFileName(req.url);
    if (!f) return notHandle();
    debug('checking php file: %s', f);

    // 验证php文件是否存在
    var rf = path.resolve(options.path, f.slice(1));
    fs.stat(rf, function (err, s) {
      // 文件不存在则不做处理
      if (err) return notHandle();
      if (!s.isFile()) return notHandle();

      // 添加到处理队列
      debug('push to queue: %s', req.url);
      queue.push(req, res, notHandle);
    });

  }
}

function RequestQueue (cgi, options) {
  this.cgi = cgi;
  this.options = options;
  this._processCounter = 0;
  this._queue = {};
  this._queueCounter = 0;
}

/**
 * 当前进程池是否空闲
 *
 * @return {Boolean}
 */
RequestQueue.prototype.isFree = function () {
  debug('queue.isFree(): counter=%d, limit=%d', this._processCounter, this.options.process.limit);
  return (this._processCounter < this.options.process.limit);
};

/**
 * 当前请求队列是否已满
 *
 * @return {Boolean}
 */
RequestQueue.prototype.isQueueFull = function () {
  debug('queue.isQueueFull(): counter=%d, limit=%d', this._queueCounter, this.options.queue.limit);
  return (this._queueCounter >= this.options.queue.limit);
};

/**
 * 添加到处理队列
 *
 * @param {ServerRequest} req
 * @param {ServerResponse} res
 * @param {Function} next
 */
RequestQueue.prototype.push = function (req, res, next) {
  debug('queue.push()');
  if (this.isFree()) {
    this.handle(req, res, next);
  } else {
    this.wait(req, res, next);
  }
};

/**
 * 处理当前请求
 *
 * @param {ServerRequest} req
 * @param {ServerResponse} res
 * @param {Function} next
 */
RequestQueue.prototype.handle = function (req, res, next) {
  debug('queue.handle()');
  var me = this;

  // 开始处理请求
  req.resume();
  var p = me.cgi.handle(req, res, next);

  // 统计当前进程数量
  me._processCounter++;
  var hasDown = false;
  function downCounter () {
    if (hasDown) return;
    me._processCounter--;
    hasDown = true;
    // 在当前进程处理完成时，检查队列
    me.checkQueue();
  }
  p._responseParser.on('error', downCounter);
  p._responseParser.on('end', downCounter);
  req.on('close', downCounter);

  // 检测超时
  setTimeout(function () {
    if (!p._responseParser.isEnd()) {
      // 响应请求超时
      me.requestTimeout(res);
      // 强行杀死进程
      p.kill();
    }
  }, me.options.process.timeout);
};

/**
 * 添加到等待队列
 *
 * @param {ServerRequest} req
 * @param {ServerResponse} res
 * @param {Function} next
 */
RequestQueue.prototype.wait = function (req, res, next) {
  debug('queue.wait()');
  var me = this;

  // 如果队列已满，直接返回服务器忙
  if (me.isQueueFull()) return me.serverBusy(res);

  // 加入队列
  var id = uuid.v4();
  me._addToQueue(id, req, res, next);

  // 检查超时
  setTimeout(function () {
    if (me._queue[id]) {
      // 直接返回服务器忙
      me.serverBusy(res);
      // 删除
      me._removeFromQueue(id);
    }
  }, me.options.queue.timeout);

  // 如果中途客户端断开连接或者出错，将其从队列中删除
  req.on('close', function () {
    me._removeFromQueue(id);
  });
};

RequestQueue.prototype._addToQueue = function (id, req, res, next) {
  this._queue[id] = [req, res, next];
  this._queueCounter++;
  debug('queue._addToQueue(%s), counter=%d', id, this._queueCounter);
};

RequestQueue.prototype._removeFromQueue = function (id) {
  delete this._queue[id];
  this._queueCounter--;
  debug('queue._removeFromQueue(%s), counter=%d', id, this._queueCounter);
};

/**
 * 处理等待队列
 */
RequestQueue.prototype.checkQueue = function () {
  debug('queue.checkQueue()');
  var me = this;
  if (!me.isFree()) return;

  for (var id in me._queue) {
    if (!me.isFree()) return;

    var item = me._queue[id];
    me._removeFromQueue(id);
    me.handle(item[0], item[1], item[2]);
  }
};

/**
 * 响应请求超时
 *
 * @param {ServerResponse} res
 */
RequestQueue.prototype.requestTimeout = function (res) {
  debug('queue.requestTimeout()');
  res.statusCode = 408;
  res.setHeader('content-type', 'text/html');
  res.end('<h1>Request Timeout</h1>');
};

/**
 * 响应服务器忙
 *
 * @param {ServerResponse} res
 */
RequestQueue.prototype.serverBusy = function (res) {
  debug('queue.serverBusy()');
  res.statusCode = 503;
  res.setHeader('content-type', 'text/html');
  res.end('<h1>Server Too Busy</h1>');
};

module.exports = initMiddleware;