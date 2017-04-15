/**
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 **/

module.exports = function(RED) {
  "use strict";
  var UPnPClient = require('node-upnp-control-point');


///////////////////////////////////////////////////////////////////////////////


  function upnpConfigurationNode(n) {
    RED.nodes.createNode(this, n);
    var node = this;
    node.deviceDescriptionUrl = n.deviceDescriptionUrl;

    node.upnpClient = new UPnPClient(node.deviceDescriptionUrl);

    //TODO events do not make sense at the moment, since discovery is not handled
    node.upnpClient.createEventListenServer();

    node.eventSubscriptions = new Set();

    node.upnpClient.on('error', function(err) {
      node.error('UPnP Client Error: ' + err);
    });

    node.upnpClient.on('subscribed', function(subMsg) {
      node.log('Subscribed to ' + subMsg.serviceType + ' with SID ' + subMsg.sid);
    });

    node.upnpClient.on('unsubscribed', function(subMsg) {
      node.log('Unsubscribed to ' + subMsg.serviceType + ' with SID ' + subMsg.sid);
    });

    node.on('close', function(done) {
      var timeout = setTimeout(function() {
        node.warn('Timeout closing');
        done();
      }, 2000);
      node.upnpClient.closeEventListenServer(function() {
        node.unsubscribeAll(node.eventSubscriptions.values().next().value, function() {
          clearTimeout(timeout);
          done();
        });
      });
    });

  }
  RED.nodes.registerType("upnp-configuration", upnpConfigurationNode);

  upnpConfigurationNode.prototype.subscribe = function(serviceType) {
    var node = this;
    if(!node.eventSubscriptions.has(serviceType)) {
      node.eventSubscriptions.add(serviceType);
      node.upnpClient.subscribe(serviceType, function(err) {
        if(err) {
          node.error(err);
          node.eventSubscriptions.delete(serviceType);
        }
      });
    }
  }

  upnpConfigurationNode.prototype.unsubscribeAll = function(serviceType, callback) {
    var node = this;
    if(node.eventSubscriptions.has(serviceType)) {
      node.upnpClient.unsubscribe(serviceType, function(err) {
        if(err) {
          node.error(err);
          callback();
        } else {
          node.eventSubscriptions.delete(serviceType);
          if(node.eventSubscriptions.size > 0) {
            node.unsubscribeAll(node.eventSubscriptions.values().next().value, callback);
          } else {
            callback();
          }
        }
      });
    } else {
      callback();
    }
  }

////////////////////////////////////////////////////////////////////////////////


  function upnpInvokeAction(config) {
    RED.nodes.createNode(this, config);
    var node = this;
    node.upnpConfiguration = RED.nodes.getNode(config.upnpConfiguration);

    node.on('input', function(m) {
      if(m.topic === "getDeviceDescription") {
        node.upnpConfiguration.upnpClient.getDeviceDescriptionParsed(function(err, description) {
          if(err) {
            node.warn(err);
          } else {
            m.payload = description;
            m.topic = "deviceDescription";
            node.send(m);
          }
        });
      } else if(m.topic === "getServiceDescription" && m.payload && typeof m.payload === "string") {
        node.upnpConfiguration.upnpClient.getServiceDescriptionParsed(m.payload, function(err, description) {
          if(err) {
            node.warn(err);
          } else {
            m.payload = description;
            m.topic = "serviceDescription";
            node.send(m);
          }
        });
      } else if(m.payload) {
        if(m.payload.serviceType && m.payload.action) {
          var params = {};
          if(m.payload.params) {
            params = m.payload.params;
          }
          node.upnpConfiguration.upnpClient.invokeActionParsed(m.payload.action, params, m.payload.serviceType, function(err, result) {
            if(err) {
              node.warn(err + '; RAW: ' + result);
            } else {
              if(result) {
                m.topic = m.payload.action;
                m.payload = result;
                node.send(m);
              }
            }
          });
        } else {
          node.warn('Payload does not contain the right information');
        }
      }
    });
  }
  RED.nodes.registerType("upnp-invokeAction", upnpInvokeAction);


  ////////////////////////////////////////////////////////////////////////////////


  function upnpReceiveEvent(config) {
    RED.nodes.createNode(this, config);
    var node = this;
    node.upnpConfiguration = RED.nodes.getNode(config.upnpConfiguration);
    var serviceType = config.serviceType;
    node.upnpConfiguration.upnpClient.on('eventListenServerListening', function(listening) {
      if(listening) {
        node.upnpConfiguration.subscribe(serviceType);
        node.status({fill: "green", shape: "dot", text: "listening"});
      } else {
        node.status({fill: "red", shape: "ring", text: "not listening"});
      }
    });
    node.upnpConfiguration.upnpClient.on('upnpEvent', function(eventMessage) {
      if(serviceType === eventMessage.serviceType) {
        var returnMsg = {payload: eventMessage};
        node.send(returnMsg);
      }
    });
  }
  RED.nodes.registerType("upnp-receiveEvent", upnpReceiveEvent);

}
