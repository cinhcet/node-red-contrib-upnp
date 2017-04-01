module.exports = function(RED) {
  "use strict";
  var UpnpClient = require('upnp-device-client');

  function upnpAction(config) {
    RED.nodes.createNode(this, config);
    var node = this;
    var upnpClient = new UpnpClient(config.url);
    node.on('input', function(m) {
      if(m.topic === "getDeviceDescription") {
        upnpClient.getDeviceDescription(function(err, description) {
          if(err) {
            node.warn(err);
          } else {
            var returnMsg = {
              payload: description,
              topic: "deviceDescription"
            };
            node.send(returnMsg);
          }
        });
      } else if(m.topic === "getServiceDescription" && m.payload && typeof m.payload === "string") {
        upnpClient.getServiceDescription(m.payload, function(err, description) {
          if(err) {
            node.warn(err);
          } else {
            var returnMsg = {
              payload: description,
              topic: "serviceDescription"
            };
            node.send(returnMsg);
          }
        });
      } else if(m.payload) {
        if(m.payload.serviceId && m.payload.action) {
          var params = {};
          if(m.payload.params) {
            params = m.payload.params;
          }
          console.log(m.payload);
          upnpClient.callAction(m.payload.serviceId, m.payload.action, params, function(err, result) {
            if(err) {
              node.warn(err);
            } else {
              if(result) {
                var returnMsg = {
                  payload: result,
                  topic: m.payload.action
                };
                node.send(returnMsg);
              }
            }
          });
        }
      }
    });
  }
  RED.nodes.registerType("upnp-action", upnpAction);
}
