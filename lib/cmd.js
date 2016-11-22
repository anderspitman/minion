var EventEmitter = require('events').EventEmitter,
    inherits = require('util').inherits,
    shortid = require('shortid'),
    utils = require('./utils/utils'),
    mkdirp = require('mkdirp'),
    spawn = require('child_process').spawn,
    fs = require('fs'),
    Promise = require('bluebird');

// run command
var cmd = function(){}

// inherit eventEmitter
inherits(cmd, EventEmitter);

cmd.prototype.init = function(tool, stream, params, opts) {
    // Call EventEmitter constructor
    EventEmitter.call(this);

    var self = this;

    this.opts = opts;
    this.tool = tool;
    this.stream = stream;
    this.minions = [];
    this.runners = []; // upstream ws and http streams/commands
    this.prog;
    this.id = params['id'] || shortid.generate();

    var rawArgs = [];
    var args = [];
    var binPath = require('path').resolve(__dirname, '../bin/');
    var fifoDirPath = require('path').resolve(__dirname, '../fifos/');
    var path = require('path').resolve(binPath, tool.path);
    var isDirectory = false;

    // test if directory
    if ( tool.path[ tool.path.length -1 ] == '/' )
        var isDirectory = true;

    var cmd = params['cmd'];
    // split commands by space into array, while escaping spaces inside double quotes
    if (cmd != null && cmd != '' && cmd != undefined && cmd != 'undefined') rawArgs = cmd.match(/(?:[^\s"]+|"[^"]*")+/g)

    // handle minion remote sources for stdin
    if(params.stdin) {
        var url = decodeURIComponent(params.stdin);
        self.minions.push( {
            'url': url,
            progStreamType: 'stdin'
        });
    }

    // handle minion remote sources in arguments
    for( var i=0; i < rawArgs.length; i++) {
        var arg = rawArgs[i];
        if ( arg.match(/^http%3A%2F%2F\S+/) || arg.match(/^ws%3A%2F%2F\S+/) || arg.match(/^https%3A%2F%2F\S+/) || arg.match(/^wss%3A%2F%2F\S+/) ) {
            // add to minions list
            var url = decodeURIComponent(arg);
            var fifo = fifoDirPath + '/fifo-' + shortid.generate();
            self.minions.push( {
                'url': url,
                'fifoPath': fifo,
                progStream: self._createFifoStream(fifo, fifoDirPath),
                progStreamType: 'fifo'
            });

            // add fifo as arg
            args.push(fifo);

            // REMOVE once fully switched to multiple stream minion
            var inOpt = tool.inputOption;
            if( inOpt != undefined && inOpt == args[args.length-1]) {
                args.splice(-1);
            }
        }
        // else if ( arg.match(/^[\'\"]http.*[\'\"]$/) )
        //     args.push( encodeURI(arg.slice(1,arg.length-1)) ); // remove quotes and reEncode since it's a url
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
    if (tool.options != undefined)
        args = tool.options.concat( args );

    // add default arguments of tool
    if (tool.args != undefined)
        args = args.concat( tool.args );

    // check that executable path is in bin sandbox for security
    var IsThere = require("is-there");
    var resolvedPath = require("path").resolve(path);
    if ( binPath != resolvedPath.substr(0, binPath.length) ) {
        var error = "Program path not in executable directory. Only programs in minion/bin/ directory are executable";
        self.emit('log', self.id + ": " + error);
        self.emit('error', self.id + ": " + error);
        return false;
    } else if( !IsThere(resolvedPath) ) {
        var error = "Program not found. Only programs in minion/bin/ directory are executable";
        self.emit('log', self.id + ": " +error);
        self.emit('error', self.id + ": " +error);
        return false;
    }
    self.path = path;
    self.args = args;
    self.params = params;
    return true;
}

cmd.prototype.params = undefined;

cmd.prototype.id = undefined;

cmd.prototype.run = function(clients, serverAddress) {
    var self = this,
        stream = this.stream;

    // spawn tool as new process
    self.emit('log', 'command ' + self.id + ': ' + self.path + ' ' + self.args);


    Promise.all( self.minions.map(function(d) { return d.progStream} )).then( function(fifoStreams) {

        var prog = spawn(self.path, self.args);
        self.prog = prog;

        // overwrite promises with fifostreams or prog.stdin
        self.minions.forEach(function(minion) {
            if (minion.progStreamType == 'fifo') {
                fifoStreams.forEach(function(fifostream) {
                    if (fifostream && minion.fifoPath == fifostream.path)
                        minion.progStream = fifostream;
                })
            } else {
                minion.progStream = prog.stdin;
            }

        })

        if(self.params.parseByLine || self.params.format != undefined) {
            var reader = self.params.parseByLine ? utils.lineReader : utils.chunkReader
            reader(prog, function(data) {
                if (self.params.format != undefined) {
                    if (self.tool[self.params.format] == undefined) {
                        stream.write( data );
                    } else
                        stream.write( self.tool[self.params.format](data) )
                } else {
                    if (stream.writable) stream.write( data );
                }
            });
        } else {
            if(self.params.encoding != 'binary') prog.stdout.setEncoding(self.params.encoding);
            // pipe output back to stream
            prog.stdout.pipe(stream);

            // save output for future caching
            if (self.opts.cache.canCache()) {
                // cache write stream
                ws = self.opts.cache.createWriteStream();

                // if tool has cacheTransform pipe through it before caching
                if(self.tool.cacheTransform)
                    prog.stdout.pipe( self.tool.cacheTransform() ).pipe( ws );
                else
                    prog.stdout.pipe( ws )
            }
        }

        // go through minion sources
	var argPos = 0;
        self.minions.forEach(function(minion,i) {
            var parsed = require('./utils/utils').parseUrlParams(minion.url);

            // get correct protocol
            if (self.params.protocol == 'websocket')
                var Runner = require('./protocol/ws');
            else if (self.params.protocol == 'http')
                var Runner = require('./protocol/http');
            if (parsed.isClient) {
                if (self.params.protocol == 'http') { self.emit('error', "trying to use http to read data from browser/client (e.g. local files). Must use websocket")}
                // create connectionId using the commandId and the fifoPath for this minion.
                var connectionId = self.id +'&'+ minion.fifoPath;
                self.emit('createClientConnection', {'id': connectionId, 'serverAddress': serverAddress, 'argPos': argPos}, self);
                self.on('clientConnected-'+minion.fifoPath, function(clientStream) {
                    var runner = new Runner();
                    runner.on('error', function(error) { self.emit('error', error); });
                    runner.run(minion, minion.progStream, {stream:clientStream});
                    self.runners.push(runner);
                })
                // increment only for real arguments, ignore stdin minions
                if (minion.progStreamType == 'fifo')
                    argPos += 1;
            } else {

                // execute minion commands
                var runner = new Runner();
                runner.on('error', function(error) { self.emit('error', error); });
                runner.on('createClientConnection', function(connection) { self.emit('createClientConnection', connection); });
                runner.on('log', function(msg) { self.emit('log', msg); });
                runner.run(minion, minion.progStream);
                self.runners.push(runner);
            }
        })

        prog.stderr.on('data', function (error) {
            self.emit('log', self.id + ": " + 'stderr - ' + error);
            self.emit('error', self.id + ": " + 'stderr - ' + error);
        });

        prog.on("close", function() {
            self.emit('log', self.id + ": " + 'prog closed')
            stream.end();
        })
        prog.stdin.on('error', function() {
            self.emit('error', self.id + ": " + 'error writing to program. possibly unconsumed data in pipe');
            self.emit('log', self.id + ": " + 'error writing to program. possibly unconsumed data in pipe');
        })

        prog.on('error', function(err) {
            self.emit('error', self.id + ": " + 'prog threw an error - ' + err);
            self.emit('log', self.id + ": " + 'prog threw an error - ' + err);
        })

        prog.on('exit', function (code) {
            if (code !== 0) {
                var error = self.id + ": " + 'prog process exited with code ' + code
                self.emit('error', error);
                self.emit('log', error);
                // remove cache
                self.deleteCache();
            }
            self.emit('log', self.id + ": " + 'prog exited')
            self.emit('exit', code);
        });
    })
}

cmd.prototype.end = function() {
    var self = this;

    // if prog is still running, clean up
    if(self.prog) {
        if (self.prog.exitCode != 0 ) {
            self.emit('log', 'command ' + self.id + ": " + ' prematurely ended. Cleaning up ...')
            self.deleteCache();
        }
    }
    self.emit('exit');

    // close upstream connections to allow prog to end gracefully
    if (self.runners.length > 0) {
        self.runners.forEach(function(r) { if(r) r.end() });
        // set timeout to kill prog in case things don't end gracefully
        setTimeout(function(){if(self.prog) { self.prog.kill('SIGINT')}}, 5000);
    }
    else { // if no upstream connections, then this is the end of the line. kill prog
        if (self.prog) self.prog.kill('SIGINT');
    }
}

cmd.prototype.deleteCache = function() {
    if (this.opts.cache)
        this.opts.cache.deleteCache();
}

cmd.prototype._createFifoStream = function(fifoPath, fifoDirPath) {
    var mypipePath = require('path').resolve(__dirname, '../mypipe.sh');
    return new Promise(function(resolve, reject) {
        mkdirp(fifoDirPath, function (err) {
            if (err) reject(err)

            var fifoprog = spawn('mkfifo', [fifoPath]);

            fifoprog.on('exit', function() {
                var fifoStream = spawn(mypipePath, [fifoPath]);
                fifoStream.on('error', function(err) {
                    console.error('fifostream error: ' + err);
                })
                fifoStream.on('close', function() {
                    fs.unlink(fifoPath);
                })
                fifoStream.stdin.path = fifoPath;
                resolve(fifoStream.stdin);
            })
        });

    })
}

module.exports = cmd;
