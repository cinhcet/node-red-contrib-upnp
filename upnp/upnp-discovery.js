module.exports = function(RED) {
  "use strict";
  var nodeSSDP = require('node-ssdp').Client;

  function upnpDiscovery(config) {
    RED.nodes.createNode(this, config);
    var node = this;
    var upnpSSDPClient = new nodeSSDP();
    upnpSSDPClient.on('response', function(headers, statusCode, rinfo) {
      var returnMsg = {
        payload: {
          headers: headers,
          statusCode: statusCode,
          rinfo: rinfo
        }
      };
      node.send(returnMsg);
    });
    node.on('input', function(m) {
      if(m.payload && typeof m.payload === "string") {
        upnpSSDPClient.search(m.payload);
      }
    });
  }
  RED.nodes.registerType("upnp-discovery", upnpDiscovery);
}
