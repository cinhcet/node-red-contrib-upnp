/**
 * Copyright 2020 cinhcet@gmail.com
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

// process.env.DEBUG = 'node-ssdp:*';

module.exports = function(RED) {
  "use strict";
  var UPnPClient = require('node-upnp-control-point');
  var SSDP = require('node-ssdp').Client;
  var EventEmitter = require('events').EventEmitter;
  var xml2js = require('xml2js');

  var UPnPLib = require('../lib/upnpLib');

  var POLLING_INTERVAL = 10000;
  var DISCOVERY_TIMEOUT = 5000;

///////////////////////////////////////////////////////////////////////////////


  function upnpConfigurationNode(n) {
    RED.nodes.createNode(this, n);
    var node = this;
    node.eventEmitter = new EventEmitter();
    node.eventEmitter.setMaxListeners(0);

    node.uuid = n.uuid;
    node.useHardcodedDeviceDescriptionURL = n.useHardcodedDeviceDescriptionURL;
    node.hardcodedDeviceDescriptionURL = n.deviceDescriptionURL;

    node.deviceDescriptionUrl = null;
    node.upnpClient = null;

    node.deviceFound = false;
    node.eventServerListening = false;
    node.eventSubscriptions = new Map();
    
    node.printLog = true;

    node.eventEmitter.on('deviceDiscovery', function(discovered) {
      if(discovered) {
        node.log('Device ' + node.uuid + ' discovered');
        node.printLog = true;
      } else {
        if(node.printLog) {
          node.log('Device ' + node.uuid + ' lost');
          node.printLog = false;
        }
      }
    });

    node.pollDevice();
    // setTimeout(node.pollDevice.bind(this), 1000);

    node.on('close', function(done) {
      function cleanUp() {
        if(node.upnpClient) node.upnpClient.cleanUp();
        node.eventEmitter.emit('deviceDiscovery', false);
        node.deviceFound = false;
        node.eventServerListening = false;
      }
      if(node.pollTimeout) {
        clearTimeout(node.pollTimeout);
      }
      if(node.upnpClient) {
        var timeout = setTimeout(function() {
          node.warn('Timeout closing');
          cleanUp();    
          done();
        }, 2000);
        node.unsubscribeAll(node.eventSubscriptions.keys().next().value, function() {
          clearTimeout(timeout);
          cleanUp();
          done();
        });
      } else {
        done();
      }
    });
  }
  RED.nodes.registerType("upnp-configuration", upnpConfigurationNode);

  upnpConfigurationNode.prototype.pollDevice = function() {
    var node = this;
    node.discovery(function(deviceDescriptionUrl) {
      function cleanUp() {
          node.eventEmitter.emit('deviceDiscovery', false);
          node.deviceDescriptionUrl = null;
          if(node.upnpClient) node.upnpClient.cleanUp();
          node.upnpClient = null;
          node.deviceFound = false;
          node.eventServerListening = false;
      }

      if(deviceDescriptionUrl) {
        if(deviceDescriptionUrl !== node.deviceDescriptionUrl) {
          cleanUp();
          node.initDevice(deviceDescriptionUrl);
        }
      } else {
        cleanUp();
      }
    });
    node.pollTimeout = setTimeout(node.pollDevice.bind(node), POLLING_INTERVAL);
  }

  upnpConfigurationNode.prototype.initDevice = function(deviceDescriptionUrl) {
    var node = this;

    node.deviceDescriptionUrl = deviceDescriptionUrl;
    node.upnpClient = new UPnPClient(node.deviceDescriptionUrl);

    node.upnpClient.on('error', function(err) {
      node.error('UPnP Client Error: ' + err);
    });

    node.deviceFound = true;
    node.eventEmitter.emit('deviceDiscovery', true);

    node.upnpClient.on('subscribed', function(subMsg) {
      node.log('Subscribed to ' + subMsg.serviceType + ' with SID ' + subMsg.sid);
    });

    node.upnpClient.on('unsubscribed', function(subMsg) {
      node.log('Unsubscribed to ' + subMsg.serviceType + ' with SID ' + subMsg.sid);
    });

    node.upnpClient.on('upnpEvent', function(eventMessage) {
      if(node.eventSubscriptions.has(eventMessage.serviceType)) {
        for(let n of node.eventSubscriptions.get(eventMessage.serviceType)) {
          n.onUpnpEvent(eventMessage);
        }
      }
    });

    node.upnpClient.on('eventListenServerListening', function(listening) {
      if(listening) {
        for(let serviceType of node.eventSubscriptions.keys()) {
          node.upnpClient.subscribe(serviceType, function(err) {
            if(err) {
              node.error(err);
              if(node.eventSubscriptions) {
                node.eventSubscriptions.delete(serviceType);
              }
            }
          });  
        }
        node.eventServerListening = true;
      } else {
        node.eventServerListening = false;
      }
    });

    node.upnpClient.createEventListenServer();
  }

  upnpConfigurationNode.prototype.discovery = function(callback) {
    var node = this;
    if(node.useHardcodedDeviceDescriptionURL) {
      if(node.hardcodedDeviceDescriptionURL && node.hardcodedDeviceDescriptionURL !== '') {
        UPnPLib.checkIfDeviceDescriptionExists(node.hardcodedDeviceDescriptionURL, function(exists) {
          if(exists) {
            callback(node.hardcodedDeviceDescriptionURL);
          } else {
            callback(null);
          }
        });
      } else {
        node.err('useHardcodedDeviceDescriptionURL but not URL set');
      }
    } else {
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
  }

  upnpConfigurationNode.prototype.subscribe = function(serviceType, n) {
    var node = this;

    if(!node.eventSubscriptions.has(serviceType)) {
      node.eventSubscriptions.set(serviceType, new Set([n]));
      if(node.deviceFound && node.eventServerListening) {
        node.upnpClient.subscribe(serviceType, function(err) {
          if(err) {
            node.error(err);
            if(node.eventSubscriptions) {
              node.eventSubscriptions.delete(serviceType);
            }
          }
        });
      }
    } else {
      node.eventSubscriptions.get(serviceType).add(n);
    }
  }

  upnpConfigurationNode.prototype.unsubscribe = function(serviceType, n) {
    var node = this;
    if(node.eventSubscriptions.has(serviceType)) {
      if(node.eventSubscriptions.get(serviceType).has(n)) {
        node.eventSubscriptions.get(serviceType).delete(n);
        /*if(node.eventSubscriptions.get(serviceType).size === 0) {
          node.eventSubscriptions.delete(serviceType);
          node.upnpClient.unsubscribe(serviceType, function(err) {
            if(err) {
              node.error(err);
            }
          });
        }*/
      }
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
            node.unsubscribeAll(node.eventSubscriptions.keys().next().value, callback);
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
    /*if(node.upnpConfiguration.deviceFound) {
      deviceDiscoveryCallback(true);
    }*/

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
    node.serviceType = config.serviceType;

    node.upnpConfiguration.subscribe(node.serviceType, node);

    node.status({fill: "red", shape: "ring", text: "not discovered"});

    node.upnpConfiguration.eventEmitter.on('deviceDiscovery', deviceDiscoveryCallback);

    function deviceDiscoveryCallback(discovered) {
      if(discovered) {
        node.status({fill: "green", shape: "dot", text: "discovered"});
      } else {
        node.status({fill: "red", shape: "ring", text: "not discovered"});
      }
    };

    node.on('close', function() {
      node.upnpConfiguration.eventEmitter.removeListener('deviceDiscovery', deviceDiscoveryCallback);
      node.upnpConfiguration.unsubscribe(node.serviceType, node);
    });
  }

  upnpReceiveEvent.prototype.onUpnpEvent = function(eventMessage) {
    var node = this;
    if(node.serviceType === eventMessage.serviceType) {
      var returnMsg = {payload: eventMessage};
      node.send(returnMsg);
    }
  }

  RED.nodes.registerType("upnp-receiveEvent", upnpReceiveEvent);

////////////////////////////////////////////////////////////////////////////////


  function upnpMediaRenderer(config) {
    RED.nodes.createNode(this, config);
    var node = this;
    node.upnpConfiguration = RED.nodes.getNode(config.upnpConfiguration);

    node.statusObject = {};
    node.transportState = null;

    node.pollTimer = null;

    node.avTransportST = 'urn:schemas-upnp-org:service:AVTransport:1';
    node.upnpConfiguration.subscribe(node.avTransportST, node);

    node.status({fill: "red", shape: "ring", text: "not discovered"});

    node.on('input', function(m) {
      if(node.upnpConfiguration.deviceFound) {
        if(m.hasOwnProperty('payload')) {
          if(m.payload === 'play') {
            node.setMedia(m, function(err) {
              if(!err) {
                var action = 'Play';
                var params = {InstanceID: '0', Speed: '1'};
                node.invokeAction(action, params, node.avTransportST);
              }
            });
          } else if(m.payload === 'stop') {
            var action = 'Stop';
            var params = {InstanceID: 0};
            node.invokeAction(action, params, node.avTransportST);
          } else if(m.payload === 'pause') {
            var action = 'Pause';
            var params = {InstanceID: 0};
            node.invokeAction(action, params, node.avTransportST);
          } else if(m.payload === 'setMedia') {
            node.setMedia(m);
          } else if(m.payload === 'seek') {
            let action = 'Seek';
            let pos = UPnPLib.convertUPnPTime(m.pos);
            let params = {InstanceID: '0', Unit: 'REL_TIME', Target: pos};
            node.invokeAction(action, params, node.avTransportST);
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
      clearInterval(node.pollTimer);
      node.upnpConfiguration.unsubscribe(node.avTransportST, node);
    });

  }

  upnpMediaRenderer.prototype.onUpnpEvent = function(eventMessage) {
    var node = this;

    if(eventMessage.serviceType === node.avTransportST) {
      if(eventMessage['events'] && eventMessage['events']['LastChange']) {
        var parseXML = require('xml2js').parseString;
        parseXML(eventMessage['events']['LastChange'], {explicitArray: false}, function(err, parsedData) {
          if(err) {
            node.warn(err);
          } else {
            if(parsedData.hasOwnProperty('Event') && parsedData['Event'].hasOwnProperty('InstanceID')) {
              parsedData = parsedData['Event']['InstanceID'];

              //console.log(parsedData);

              var temp = {};
              if(parsedData['CurrentTrackURI']) temp.file = parsedData['CurrentTrackURI']['$']['val'];
              if(parsedData['TransportState']) {
                node.transportState = parsedData['TransportState']['$']['val'];
                temp.state = node.transportState;
              }
              if(parsedData['CurrentTrackDuration']) {
                var duration = UPnPLib.parseUPnPTime(parsedData['CurrentTrackDuration']['$']['val']);
                if(duration > 0) {
                  temp.duration = duration;
                }
              }
              if(parsedData['CurrentTrackMetaData'] && parsedData['CurrentTrackMetaData']['$'] && parsedData['CurrentTrackMetaData']['$']['val']) {
                UPnPLib.parseRawDIDLItem(parsedData['CurrentTrackMetaData']['$']['val'], function(err, metadata) {
                  if(err) {
                    node.warn(err);
                  } else {
                    if(metadata.duration && temp.duration) delete metadata.duration;
                    Object.assign(temp, metadata);
                  }
                });
              }

              if(temp.file && node.statusObject.file && temp.file !== node.statusObject.file) {
                let state = node.statusObject.state;
                node.statusObject = temp;
                node.statusObject.state = state;
              } else {
                Object.assign(node.statusObject, temp);
              }
              
              if(node.statusObject['state'] === 'PLAYING') {
                clearInterval(node.pollTimer);
                node.pollTimerFunction();
                node.pollTimer = setInterval(function() { node.pollTimerFunction(); }, 1000);
              } else {
                clearInterval(node.pollTimer);
              }

              var returnMsg = {payload: 'currentPlayingItem', item: node.statusObject};
              node.send(returnMsg);
            }
          }
        });
      }
    }
  }

  upnpMediaRenderer.prototype.pollTimerFunction = function() {
    var node  = this;
    var action = 'GetPositionInfo';
    var params = {InstanceID: 0};
    node.invokeAction(action, params, node.avTransportST, function(err, result) {
      if(!err) {
        if(result['GetPositionInfoResponse']) {
          var parsedData = result['GetPositionInfoResponse'];
          var temp = {};
          if(parsedData['TrackURI']) temp.file = parsedData['TrackURI'];
          if(parsedData['TrackDuration']) {
            var duration = UPnPLib.parseUPnPTime(parsedData['TrackDuration']);
            if(duration > 0) {
              temp.duration = duration;
            }
          }

          if(parsedData['RelTime']) temp.relTime = UPnPLib.parseUPnPTime(parsedData['RelTime']);
          if(parsedData['AbsTime']) temp.absTime = UPnPLib.parseUPnPTime(parsedData['AbsTime']);
          if(parsedData['TrackMetaData']) {
            UPnPLib.parseRawDIDLItem(parsedData['TrackMetaData'], function(err, metadata) {
              if(err) {
                node.warn(err);
              } else {
                if(metadata.duration && temp.duration) delete metadata.duration;
                
                Object.assign(temp, metadata);
              }
            });
          }

          Object.assign(node.statusObject, temp);
          // console.log(node.statusObject);
          var returnMsg = {payload: 'currentPlayingItem', item: node.statusObject};
          node.send(returnMsg);
        }
      }
    });
  }

  upnpMediaRenderer.prototype.setMedia = function(m, callback) {
    var node = this;
    if(m.hasOwnProperty('rawDIDL') && m.hasOwnProperty('rawDIDL')) {
      var action = 'SetAVTransportURI';
      var params = {InstanceID: 0, CurrentURI: m.uri, CurrentURIMetaData: m.rawDIDL};
      node.invokeAction(action, params, node.avTransportST, callback);
    } else if(m['item'] && m.item['res'] && m.item['res'][0] && m.item['res'][0]['_']) {
      var action = 'SetAVTransportURI';
      var metadata = node.createMetadata(m.item);
      var uri = m.item['res'][0]['_'];
      var params = {InstanceID: 0, CurrentURI: uri, CurrentURIMetaData: metadata};
      node.invokeAction(action, params, node.avTransportST, callback);
    } else {
      callback();
    }
  }

  upnpMediaRenderer.prototype.invokeAction = function(action, params, serviceType, callback) {
    var node = this;
    if(node.upnpConfiguration && node.upnpConfiguration.upnpClient && node.upnpConfiguration.deviceFound) {
      node.upnpConfiguration.upnpClient.invokeActionParsed(action, params, serviceType, function(err, result) {
        if(err) {
          node.warn(err + '; RAW: ' + result);
        }
        if(callback) {
          callback(err, result);
        }
      });
    }
  }

  upnpMediaRenderer.prototype.createMetadata = function(item) {
    var xmlBuilder = new xml2js.Builder({headless: true, renderOpts: {'pretty': false}});
    var obj = {item: item};
    var xmlMetadata = '<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dlna="urn:schemas-dlna-org:metadata-1-0/">';
    xmlMetadata += xmlBuilder.buildObject(obj);
    xmlMetadata += '</DIDL-Lite>';
    return xmlMetadata;
  }

  RED.nodes.registerType("upnp-mediaRenderer", upnpMediaRenderer);


////////////////////////////////////////////////////////////////////////////////

  function upnpMediaContentBrowser(config) {
    RED.nodes.createNode(this, config);
    var node = this;
    node.upnpConfiguration = RED.nodes.getNode(config.upnpConfiguration);

    node.mediaBrowser = new UPnPLib.MediaBrowser(node.upnpConfiguration);

    node.status({fill: "red", shape: "ring", text: "not discovered"});

    node.on('input', function(m) {
      if(node.upnpConfiguration.deviceFound) {
        if(m.hasOwnProperty('payload')) {
          if(m.payload === 'browse') {
            var objectID = '0';
            if(m.hasOwnProperty('objectID')) {
              objectID = m.objectID;
            }
            node.mediaBrowser.browseObjectID(objectID, 0, 0, function(err, browseReturn) {
              if(!err) {
                m.payload = 'browseReturn';
                if(browseReturn.children) {
                  m.children = browseReturn.children;
                }
                if(browseReturn.metadata) {
                  m.metadata = browseReturn.metadata;
                }
                node.send(m);
              }
            });
          } else if(m.payload === 'getAllItems') {
            if(m.hasOwnProperty('objectID')) {
              var objectID = m.objectID;
              node.mediaBrowser.browseAllChildren(objectID, false, null, function(err, allChildren) {
                if(err) {
                  node.warn(err);
                } else {
                  var sendObj = {payload: 'getAllItemsReturn', objectID: objectID, items: allChildren};
                  node.send(sendObj);
                }
              });
            } else {
              node.warn('objectID missing');
            }
          } else if(m.payload === 'getMetadata') {
            if(m.hasOwnProperty('objectID')) {
              var objectID = m.objectID;
              node.mediaBrowser.browseContent(objectID, 'metadata', true, null, function(err, result) {
                if(!err) {
                  if(result.obj && Object.keys(result.obj).length) {
                    var temp = result.obj;
                    Object.assign(m, temp);
                    Object.assign(m, {rawXML: result.rawXML});
                    m.payload = 'metadataReturn';
                    node.send(m);
                  }
                }
              });
            } else {
              node.warn('objectID missing');
            }
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

  RED.nodes.registerType("upnp-mediaContentBrowser", upnpMediaContentBrowser);

  ////////////////////////////////////////////////////////////////////////////////
  //< > |
}
