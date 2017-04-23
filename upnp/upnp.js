/**
 * Copyright 2017 cinhcet@gmail.com
 *
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
  var SSDP = require('node-ssdp').Client;
  var EventEmitter = require('events').EventEmitter;

  var POLLING_INTERVAL = 10000;
  var DISCOVERY_TIMEOUT = 5000;

///////////////////////////////////////////////////////////////////////////////


  function upnpConfigurationNode(n) {
    RED.nodes.createNode(this, n);
    var node = this;
    node.eventEmitter = new EventEmitter();
    node.eventEmitter.setMaxListeners(0);

    node.uuid = n.uuid;

    node.deviceFound = false;

    node.eventEmitter.on('deviceDiscovery', function(discoverd) {
      if(discoverd) {
        node.log('Device ' + node.uuid + ' discoverd');
      } else {
        node.log('Device ' + node.uuid + ' lost');
      }
    });

    node.pollDevice();

    node.on('close', function() {
      if(node.pollTimeout) {
        clearTimeout(node.pollTimeout);
      }
    });
  }
  RED.nodes.registerType("upnp-configuration", upnpConfigurationNode);

  upnpConfigurationNode.prototype.pollDevice = function() {
    var node = this;
    node.discovery(function(deviceDescriptionUrl) {
      if(deviceDescriptionUrl) {
        if(deviceDescriptionUrl !== node.deviceDescriptionUrl) {
          node.eventEmitter.emit('deviceDiscovery', false);
          node.deviceDescriptionUrl = null;
          node.eventSubscriptions = null;
          if(node.upnpClient) node.upnpClient.cleanUp();
          node.upnpClient = null;
          node.deviceFound = false;
          node.initDevice(deviceDescriptionUrl);
        }
      } else {
        node.eventEmitter.emit('deviceDiscovery', false);
        node.deviceDescriptionUrl = null;
        node.eventSubscriptions = null;
        if(node.upnpClient) node.upnpClient.cleanUp();
        node.upnpClient = null;
        node.deviceFound = false;
      }
    });
    node.pollTimeout = setTimeout(function() {
      node.pollDevice();
    }, POLLING_INTERVAL);
  }

  upnpConfigurationNode.prototype.initDevice = function(deviceDescriptionUrl) {
    var node = this;

    node.deviceDescriptionUrl = deviceDescriptionUrl;
    node.upnpClient = new UPnPClient(node.deviceDescriptionUrl);

    node.deviceFound = true;
    node.eventEmitter.emit('deviceDiscovery', true);

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
      if(node.upnpClient) {
        var timeout = setTimeout(function() {
          node.warn('Timeout closing');
          if(node.upnpClient) node.upnpClient.cleanUp();
          node.eventEmitter.emit('deviceDiscovery', false);
          node.deviceFound = false;
          done();
        }, 2000);
        node.unsubscribeAll(node.eventSubscriptions.values().next().value, function() {
          clearTimeout(timeout);
          if(node.upnpClient) node.upnpClient.cleanUp();
          node.eventEmitter.emit('deviceDiscovery', false);
          node.deviceFound = false;
          done();
        });
      } else {
        done();
      }
    });
  }

  upnpConfigurationNode.prototype.discovery = function(callback) {
    var node = this;
    var ssdp = new SSDP();
    ssdp.search('ssdp:all');
    var timeout = setTimeout(function() {
      ssdp.stop();
      callback(null);
    }, DISCOVERY_TIMEOUT);
    ssdp.on('response', function(headers, statusCode, rinfo) {
      if(headers.USN.indexOf(node.uuid) == 5) {
        clearTimeout(timeout);
        ssdp.stop();
        callback(headers.LOCATION);
      }
    });
  }

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

    node.status({fill: "red", shape: "ring", text: "not discovered"});

    node.on('input', function(m) {
      if(node.upnpConfiguration.deviceFound) {
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
        } else if(m.hasOwnProperty('payload')) {
          if(m.payload.hasOwnProperty('serviceType') && m.payload.hasOwnProperty('action')) {
            var params = {};
            if(m.payload.hasOwnProperty('params')) {
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
      }
    });

    node.upnpConfiguration.eventEmitter.on('deviceDiscovery', deviceDiscoveryCallback);

    function deviceDiscoveryCallback(discovered) {
      if(discovered) {
        node.status({fill: "green", shape: "dot", text: "discovered"});
      } else {
        node.status({fill: "red", shape: "ring", text: "not discovered"});
      }
    }

    node.on('close', function() {
      node.upnpConfiguration.eventEmitter.removeListener('deviceDiscovery', deviceDiscoveryCallback);
    });

  }
  RED.nodes.registerType("upnp-invokeAction", upnpInvokeAction);


  ////////////////////////////////////////////////////////////////////////////////


  function upnpReceiveEvent(config) {
    RED.nodes.createNode(this, config);
    var node = this;
    node.upnpConfiguration = RED.nodes.getNode(config.upnpConfiguration);
    var serviceType = config.serviceType;

    node.status({fill: "red", shape: "ring", text: "not discovered"});

    node.upnpConfiguration.eventEmitter.on('deviceDiscovery', deviceDiscoveryCallback);

    function deviceDiscoveryCallback(discovered) {
      if(discovered) {
        node.status({fill: "green", shape: "dot", text: "discovered"});
        node.upnpConfiguration.upnpClient.on('eventListenServerListening', function(listening) {
          if(listening) {
            node.upnpConfiguration.subscribe(serviceType);
          }
        });
        node.upnpConfiguration.upnpClient.on('upnpEvent', function(eventMessage) {
          if(serviceType === eventMessage.serviceType) {
            var returnMsg = {payload: eventMessage};
            node.send(returnMsg);
          }
        });
      } else {
        node.status({fill: "red", shape: "ring", text: "not discovered"});
      }
    };

    node.on('close', function() {
      node.upnpConfiguration.eventEmitter.removeListener('deviceDiscovery', deviceDiscoveryCallback);
    });
  }
  RED.nodes.registerType("upnp-receiveEvent", upnpReceiveEvent);

}
