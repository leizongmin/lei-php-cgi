var http = require('http');
var CGI = require('./lib/cgi');

var cgi = new CGI('php-cgi', {
  DOCUMENT_ROOT: __dirname
}, ['-c', __dirname]);
console.log(cgi);
var s = http.createServer(function (req, res) {
  cgi.handle(req, res);
});
s.listen(3000);
