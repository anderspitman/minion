
module.exports = function() {
   var express = require('express'),
       app = express();
       
       
   // add public folder
   app.use('/', express.static(__dirname + '/public'));
   
   // add status service
   app.get('/status', function(req, res){
     res.header('Content-Type', 'application/json');
     res.header('Charset', 'utf-8')
     res.send(req.query.callback + '({"status": "running"});');
   });
   
   // add status service
   app.get('/help', function(req, res){
     var fs = require("fs");
     var ejs = require("ejs");
     var fullUrl = req.protocol + "://" + req.get('host');
     var compiled = ejs.compile(fs.readFileSync(__dirname + '/help.ejs', 'utf8'));
     module.exports.tool['serviceUrl'] = fullUrl;
     var html = compiled( module.exports.tool );
     res.send(html);
   });
   

   // handle http requests
   app.get('/', function (req, res) {
     if(req.query.cmd == undefined) {
        // return instructions for empty commands
        var fs = require("fs");
        var ejs = require("ejs");
        var fullUrl = req.protocol + "://" + req.get('host');
        var compiled = ejs.compile(fs.readFileSync(__dirname + '/help.ejs', 'utf8'));
        module.exports.tool['serviceUrl'] = fullUrl;
        var html = compiled( module.exports.tool );
        res.send(html);
     } else {
        // execute command
        res.writeHead(200, {
          // "Content-Type": 'application/octet-stream'
          "Content-Type": 'text/plain'
        });
        // console.log(req);
        console.log('req.query.cmd = ' + req.query.cmd );
        req.query.protocol = req.query.protocol || 'websocket';
        console.log('params = ' + JSON.stringify(req.query));
        module.exports.runCommand(
             req.query,
             {   data: function(data) {if(data!= undefined) res.write(data);},
                 end:  function() { setTimeout(function() {res.end()}, 2000); }
             }
          );
     }
   });
       
   return app;
}

module.exports.tool = undefined;
module.exports.addTool = function(newTool){ this.tool = newTool };

// handle websocket requests
module.exports.listen = function(io) {
   io.sockets.on('connection', function (socket) {            
      socket.on('run', function (params) {
         console.log("here params = " + JSON.stringify(params));
         params.protocol = params.protocol || 'websocket';
         params.event = params.event || 'results';
         module.exports.runCommand(
            params, 
            {  data: function(data) {
                        if(data != undefined ) {
                           if (params.binary)
                              socket.emit( params.event, { data : new Buffer(data, 'binary').toString('base64'), options : { binary:true } });
                           else
                              socket.emit( params.event, { data : String(data) } );
                        }
                     },
               start: function() { socket.emit('start'); },
               end: function() { socket.emit('end'); }
            }
         );
      });
   });
};

// run command
module.exports.runCommand = function(params, options) {      
   var spawn = require('child_process').spawn,
       minionClient = require('./minion-client');
   var minions = [];
   var rawArgs = [];
   var args = [];   
   var binPath = require('path').resolve(__dirname, 'bin/');
   var path = require('path').resolve(binPath, module.exports.tool.path);
   var isDirectory = false;
   
   // test if directory
   if ( module.exports.tool.path[ module.exports.tool.path.length -1 ] == '/' )
      var isDirectory = true;   

   if (params['cmd'] == undefined && params['url'] != undefined) {
      var q = minionClient.url.parse(params['url']).query;
      for (var attr in q) { params[attr] = q[attr]; } // merge params in query into params object
   }
   var cmd = params['cmd'];
   // split commands by space into array, while escaping spaces inside double quotes
   console.log('cmad = ' + params['url']);
   if (cmd != undefined) rawArgs = cmd.match(/(?:[^\s"]+|"[^"]*")+/g)
   
   console.log("raw args = " + rawArgs);

   // look for minion remote sources
   for( var i=0; i < rawArgs.length; i++) {
      var arg = rawArgs[i];
      // if ( arg.match(/^http:\/\/\S+/) ) {   
      if ( arg.match(/^http%3A%2F%2F\S+/) ) {   
         console.log('mArg = ' + arg);
         minions.push( decodeURIComponent(arg) );         
         var inOpt = module.exports.tool.inputOption;
         if( inOpt != undefined && inOpt == args[args.length-1]) {
            args.splice(-1);
         }
      }
      else if ( arg.match(/^[\'\"].*[\'\"]$/) )
         args.push( arg.slice(1,arg.length-1) ); // remove quotes
      else
         args.push( arg );
   }
   
   // check if path is to a directory and if so remove
   // the first argument and append to path as program name
   if (isDirectory) {
       path += "/" + args.splice(0,1);
   }
   
   // add default options of tool
   if (module.exports.tool.options != undefined)
      args = module.exports.tool.options.concat( args );
   
   // add default arguments of tool
   if (module.exports.tool.args != undefined)
      args = args.concat( module.exports.tool.args );
   
   // send start event
   if (options.start != undefined) options.start();
      
   // check that executable path is in bin sandbox for security
   var resolvedPath = require("path").resolve(path);
   if ( binPath != resolvedPath.substr(0, binPath.length) ) {
      options.data( "command not found" );
      options.end();
      return; // return and do not execute command if outside bin sandbox
   }
  
   console.log('command: ' + path + ' ' + args);
   
   // spawn tool as new process
   var prog = spawn(path, args);        
   
   // handle prog output
   var reader = params.parseByLine ? module.exports.lineReader : module.exports.chunkReader
   reader(prog, function(data) {
          if (params.format != undefined) {
               if (module.exports.tool[params.format] == undefined) {
                  // ADD ERROR HANDLING - SEND ERROR HASH BACK TO CLIENT
                  // send raw data anyway
                  options.data( data );
               } else
                  options.data( module.exports.tool[params.format](data) )
            } else {
               options.data( data );
            }
      });
   
   // send requests to minion sources
   if (params.protocol == 'websocket')
      module.exports.websocketRequest(minions, prog)
   else if (params.protocol == 'http')
      module.exports.httpRequest(minions, prog)
   
                       

   prog.stderr.on('data', function (data) {
      console.log(module.exports.tool['name'] + ' ERROR: ' + data);
   });

   prog.on('exit', function (code) {
      if (options.end != undefined) options.end();
      if (code !== 0) {
         console.log('prog process exited with code ' + code);
      }
   }); 
}

module.exports.httpRequest = function(sources, prog) {
   var http = require('http');
   console.log('HHHTTTTTTTPPPPPPP');
   // handle minion sources
   for ( var j=0; j < sources.length; j++ ) {                
        var url = sources[j];
        console.log('url = ' + url);
        var req = http.request(url, function(res) {           
            res.on('data', function(chunk) {
               prog.stdin.write( chunk );
            })
            res.on('end', function () {
               // might need ?
               prog.stdin.end();
            });
        });
        req.end();
   }
}

//
module.exports.websocketRequest = function(sources, prog) {
   var minionClient = require('./minion-client');
   console.log('WEBSOCKCKCKCKCKCKCKCK');
   // handle minion sources
   for ( var j=0; j < sources.length; j++ ) {
                  
        var ioClient = require('socket.io-client');
        var source = minionClient.url.parse( sources[j] );
        console.log('host = ' + source.host);
        var clientSocket = ioClient.connect( source.host,  {'force new connection': true} );
        
        // start
        clientSocket.emit('run', source.query);
        
        // handle results
        clientSocket.on('results', function(args) {
           var data = args.data,
               options = args.options || {};

           if (options.binary)
              prog.stdin.write( new Buffer(data, 'base64').toString('binary'), 'binary' );
           else
              prog.stdin.write( data );
        });
        
        // client finished
        clientSocket.on('end', function() {
           prog.stdin.end()
        });
   }  
}

module.exports.lineReader = function(prog, callback) {
   var rl = require('readline').createInterface({
     input: prog.stdout,
     terminal: false
   });
   
   rl.on('line', function (line) {
      callback(line);
   });
   
}

module.exports.chunkReader = function(prog, callback) {
   prog.stdout.on('data', function (chunk) {
        callback(chunk);
      });
}

module.exports.sanitize = function(cmd) {
   // TODO
}




