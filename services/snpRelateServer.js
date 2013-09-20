#!/usr/bin/env node

// temporary until i understand why freebayes seg faults on the stream
process.on('uncaughtException', function (exception) {
   // handle or ignore error
});

var minion = require('../minion'),
    http = require('http'),
    app = minion(),
    server = http.createServer(app),
    port = 8010;
    
// process command line options
process.argv.forEach(function (val, index, array) {
  if(val == '--port' && array[index+1]) port = array[index+1];
});

// setup socket
var io = require('socket.io').listen(server);

// set production environment
io.enable('browser client minification');  // send minified client
io.enable('browser client etag');          // apply etag caching logic based on version number
io.enable('browser client gzip');          // gzip the file
io.set('log level', 1);                    // reduce logging

// start server
server.listen(port);

// define tool
var tool = {
   apiVersion : "0.1",
   name : 'pca',
   path: 'snpRelateHelper.R',   
   json: function(data) {
      var samples = data.split("\t");
      // console.log(JSON.stringify(samples));
      var results = []; 
      for (var i=0; i < samples.length; i++) {
         var s = samples[i].split(",");
         if(s[2] != '')
            results.push([ parseFloat(s[0]), parseFloat(s[1]), s[2].trim() ]);
      }
      return JSON.stringify(results);
   },
   // instructional data used in /help
   description : 'R package for performing PCA analysis on variant data',
   exampleUrl : ""
};

// add tool to minion server
minion.addTool(tool);

// start minion socket
minion.listen(io);