/*
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
*/

var connect = require('connect');
var php = require('./lib/php');

var app = connect();
app.use(php({
  process: {
    limit:   1,
    //timeout: 1000
  },
  queue: {
    limit:   1,
    //timeout: 2000
  }
}));
app.listen(3000);
