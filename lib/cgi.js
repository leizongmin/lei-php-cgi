/**
 * CGI执行器
 *
 * @author Zongmin Lei<leizongmin@gmail.com>
 */

var os = require('os');
var spawn = require('child_process').spawn;
var path = require('path');
var fs = require('fs');
var url = require('url');
var EventEmitter = require('events').EventEmitter;
var util = require('util');
var debug = require('./debug')('cgi');


// 默认环境
var DEFAULT_ENV = {
  SERVER_SOFTWARE:      'Node.js/' + process.version,
  SERVER_PROTOCOL:      'HTTP/1.1',
  GATEWAY_INTERFACE:    'CGI/1.1',
  SERVER_NAME:          os.hostname() || 'unknown',
  SERVER_PORT:          80,
  REDIRECT_STATUS_ENV:  0,
  REDIRECT_STATUS:      200
};

/**
 * 合并对象
 *
 * @param {Object} a
 * @param {Object} b
 * @return {Object}
 */
function merge (a, b) {
  var c = {};
  for (var i in a) c[i] = a[i];
  for (var i in b) c[i] = b[i];
  return c;
}

/**
 * 统一将文件路径中的\转换成/
 *
 * @param {String} str
 * @return {String}
 */
function replaceSlash (str) {
  return str.replace(/\\/g, '/');
}

/**
 * 根据host请求头来解析host和port
 *
 * @param {String} str
 * @return {Object}
 */
function parseHost (str) {
  var i = str.indexOf(':');
  if (i === -1) return {host: str, port: 80};
  return {host: str.substr(0, i), port: Number(str.substr(i + 1))};
}

/**
 * 根据 ServerRequest 对象生成环境变量
 *
 * @param {ServerRequest} req
 * @param {Object} reqEnv
 * @return {Object}
 */
function makeRequestEnv (req, reqEnv) {
  var reqdata = url.parse(req.url);
  reqEnv = reqEnv || {};

  // 基本信息
  reqEnv.SCRIPT_NAME = replaceSlash(reqdata.pathname);
  reqEnv.PHP_SELF = reqEnv.SCRIPT_NAME;
  var filename = reqdata.pathname.substr(1);
  reqEnv.DOCUMENT_ROOT = replaceSlash(reqEnv.DOCUMENT_ROOT);
  reqEnv.PATH_INFO = replaceSlash(path.resolve(reqEnv.DOCUMENT_ROOT, filename));
  reqEnv.PATH_TRANSLATED = replaceSlash(path.resolve(reqEnv.DOCUMENT_ROOT, filename));
  reqEnv.REQUEST_METHOD = req.method;
  reqEnv.QUERY_STRING = reqdata.query || '';
  var hostInfo = parseHost(req.headers.host);
  reqEnv.SERVER_NAME = hostInfo.host;
  reqEnv.SERVER_ADDR = req.connection.localAddress || reqEnv.SERVER_ADDR || '';
  reqEnv.SERVER_PORT = req.connection.localPort || reqEnv.SERVER_PORT || '';
  reqEnv.REMOTE_ADDR = req.connection.remoteAddress || '';
  reqEnv.REMOTE_PORT = req.connection.remotePort || '';

  // 请求头
  for (var i in req.headers) {
    reqEnv['HTTP_' + i.toUpperCase().split('-').join('_')] = req.headers[i];
  }
  if ('content-length' in req.headers) {
    reqEnv.CONTENT_LENGTH = req.headers['content-length'];
  }
  if ('content-type' in req.headers) {
    reqEnv.CONTENT_TYPE = req.headers['content-type'];
  }
  if ('authorization' in req.headers) {
    reqEnv.AUTH_TYPE = req.headers.authorization.split(' ')[0];
  }

  return reqEnv;
}

/**
 * 查找CRLF+CRLF的位置
 *
 * @param {Buffer} buf
 * @return {Number}
 */
function find2CRLF (buf) {
  var end = buf.length - 3;
  for (i = 0; i < end; i++) {
    if (buf[i] === 13 && buf[i + 1] === 10 && buf[i + 2] === 13 && buf[i + 3] === 10) {
      return i;
    }
  }
  return -1;
}

/**
 * 生成处理请求实例
 *
 * @param {String} bin 可执行文件路径
 * @param {Object} env 环境变量
 * @param {Array} args 启动参数
 */
function CGI (bin, env, args) {
  this.bin = bin;
  this.env = merge(DEFAULT_ENV, env);
  this.args = args || [];
  debug('new CGI instance: bin=%s, env=%s, args=%s', bin, JSON.stringify(env), args.join(' '));
}

/**
 * 处理请求
 *
 * @param {ServerRequest} req
 * @param {ServerResponse} res
 * @param {Function} next
 * @return {ChildProcess}
 */
CGI.prototype.handle = function (req, res, next) {
  var me = this;
  next = next || function (err) {
    debug('handle: no next()');
    if (err) {
      res.statusCode = 500;
      res.end((err.stack || err).toString());
    } else {
      res.end();
    }
  };

  debug('spawn');
  var env = makeRequestEnv(req, me.env);
  for (var i in env) debug('env: %s=%s', i, env[i]);

  var cgi = spawn(me.bin, me.args, {
    env: env
  });
  req.pipe(cgi.stdin);
  cgi.stdout.pause();
  cgi.stderr.pause();

  var p = new ResponseParser(cgi);
  p.on('error', function (err) {
    debug('response: error=%s', err.stack || err);
    next(err);
  });
  p.on('status', function (s) {
    debug('response: status=%s', s);
    res.statusCode = s;
  });
  p.on('header', function (h, v) {
    debug('response: header=%s:%s', h, v);
    res.setHeader(h, v);
  });
  p.on('body', function () {
    if (!res.getHeader('content-length')) {
      res.setHeader('Transfer-Encoding', 'chunked');
    }
  });
  p.on('stdout', function (b) {
    res.write(b);
  });
  p.on('stderr', function (b) {
    res.write(b);
  });
  p.on('end', function () {
    debug('response: end');
    res.end();
  });

  cgi._responseParser = p;
  return cgi;
}

/**
 * 解析CGI程序的响应
 *
 * @param {ChildProcess} cgi
 */
function ResponseParser (cgi) {
  var me = this;
  this.cgi = cgi;
  this._hasError = false;
  this._hasEnd = false;
  this._headersSent = false;
  this._headersBuffer = [];

  // stdout输出
  cgi.stdout.on('data', function (b) {
    me._push(b);
  });

  // stderr输出
  cgi.stderr.on('data', function (b) {
    me.emit('stderr', b);
  });

  // 进程退出
  cgi.on('exit', function() {
    me._end();
  });

  // 进程出错
  cgi.on('error', function (err) {
    if (err.code === 'OK') return me._end();
    me._error(err);
  });

  cgi.stdout.resume();
  cgi.stderr.resume();
}
util.inherits(ResponseParser, EventEmitter);

/**
 * 检查是否已结束
 *
 * @return {Boolean}
 */
ResponseParser.prototype.isEnd = function () {
  return this._hasEnd || this._hasError;
};

/**
 * 程序结束
 */
ResponseParser.prototype._end = function () {
  var isEnd = this.isEnd();
  this._hasEnd = true;
  if (!isEnd) this.emit('end');
};

/**
 * 程序出错
 */
ResponseParser.prototype._error = function (err) {
  var isEnd = this.isEnd();
  this._hasError = true;
  if (!isEnd) this.emit('error', err);
};

/**
 * 收到数据
 *
 * @param {Buffer} data
 */
ResponseParser.prototype._push = function (data) {
  var me = this;

  if (me._headersSent) return me.emit('stdout', data);

  me._headersBuffer.push(data);
  var b = Buffer.concat(me._headersBuffer);
  var bi = find2CRLF(b);
  if (bi === -1) {
    me._headersBuffer = [b];
  } else {

    var lines = b.slice(0, bi).toString().split('\r\n');
    var status = lines[0].trim().match(/\d+/g)[0];
    me.emit('status', Number(status));

    for (var l = 1; l < lines.length; l++) {
      var i = lines[l].indexOf(':');
      if (i === -1) i = lines[l].length;
      var h = lines[l].substr(0, i).trim();
      var v = lines[l].substr(i + 1).trim();
      me.emit('header', h, v);
    }

    me._headersSent = true;
    me._headersBuffer = null;
    me.emit('body');
    me.emit('stdout', b.slice(bi + 4));
  }
};

module.exports = CGI;
