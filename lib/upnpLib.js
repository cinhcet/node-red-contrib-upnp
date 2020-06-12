"use strict";

var http = require('http');
var urlLib = require("url");

function MediaBrowser(upnpConfig) {
  var me = this;
  me.upnpConfiguration = upnpConfig;
}

MediaBrowser.prototype.browseContent = function(objectID, type, returnRaw, nonDefaultParameter, callback) {
  var me = this;
  var serviceType = 'urn:schemas-upnp-org:service:ContentDirectory:1';
  var params = {ObjectID: objectID, Filter: "*", StartingIndex: 0, RequestedCount: 0, SortCriteria: ""};
  if(type === "children") {
    params.BrowseFlag =  "BrowseDirectChildren";
  } else if(type === "metadata") {
    params.BrowseFlag =  "BrowseMetadata";
  } else {
    callback(new Error('unknown browse type'));
  }
  if(nonDefaultParameter) {
    Object.assign(params, nonDefaultParameter);
  }

  me.upnpConfiguration.upnpClient.invokeActionParsed('Browse', params, serviceType, function(err, result) {
    if(err) {
      callback(new Error("Error " + err + '; RAW: ' + result));
    } else {
      if(result) {
        var browseResult = result;
        if(browseResult['BrowseResponse'] && browseResult['BrowseResponse']['Result'] && browseResult['BrowseResponse']['NumberReturned'] && browseResult['BrowseResponse']['TotalMatches']) {
          var numberReturned = browseResult['BrowseResponse']['NumberReturned'];
          var totalMatches = browseResult['BrowseResponse']['TotalMatches'];
          browseResult = browseResult['BrowseResponse']['Result'];

          var returnObj = {numberReturned: numberReturned, totalMatches: totalMatches};
          if(returnRaw) {
            returnObj.rawXML = browseResult;
          }
          if(numberReturned === "0") {
            callback(null, returnObj);
          } else {
            var parseXML = require('xml2js').parseString;
            parseXML(browseResult, {explicitArray: true}, function(err, parsedData) {
              if(err) {
                callback(new Error(err));
              } else {
                if(parsedData['DIDL-Lite']) {
                  returnObj.obj = parsedData['DIDL-Lite'];
                  delete returnObj.obj['$'];
                  callback(null, returnObj);
                } else {
                  callback(new Error("Problem with UPnP response"));
                }
              }
            });
          }
        } else {
          callback(new Error("UPnP response malformed"));
        }
      } else {
        callback(new Error("Problem with UPnP response"));
      }
    }
  });
}

MediaBrowser.prototype.browseObjectID = function(objectID, startingIndex, requestedCount, callback) {
  var me = this;
  var returnObj = {};
  me.browseContent(objectID, 'children', false, {StartingIndex: startingIndex, RequestedCount: requestedCount}, function(err, result) {
    if(err) {
      callback(err);
    } else {
      returnObj.children = {};
      returnObj.children.totalMatches = result.totalMatches;
      returnObj.children.numberReturned = result.numberReturned;
      if(result.obj && Object.keys(result.obj).length) {
        Object.assign(returnObj.children, result.obj);
      }
      me.browseContent(objectID, 'metadata', false, null, function(err, result) {
        if(err) {
          callback(err);
        } else {
          if(result.numberReturned === "1") {
            returnObj.metadata = result.obj;
            callback(null, returnObj);
          } else {
            callback(new Error("No metadata"));
          }
        }
      });
    }
  });
}

MediaBrowser.prototype.browseAllChildren = function(objectID, onlyObjectID, excludeThoseContainers, callback) {
  var me = this;

  function browseAllChildrenRecursively(objectID) {
    return new Promise(function(resolve, reject) {
      me.browseContent(objectID, 'children', false, null, function(err, result) {
        let itemList = [];
        if(err) {
          reject(err);
        } else {
          if(result.obj) {
            // add items of current container
            if(result.obj.item && result.obj.item.length) {
              result.obj.item.forEach(function(item) {
                if(onlyObjectID) {
                  itemList.push(item['$']['id']);
                } else {
                  itemList.push(item);
                }
              });
            }
            // if container, recursive call
            if(result.obj.container && result.obj.container.length) {
              // promise which waits for all sub promises to be fulfilled
              Promise.all(result.obj.container.map(function(container) {
                if(excludeThoseContainers && excludeThoseContainers.includes(container['dc:title'][0])) {
                  return Promise.resolve([]);
                }
                return browseAllChildrenRecursively(container['$']['id'])
              }))
              .then(function(temp) {
                temp.forEach(function(t) {
                  itemList.push(...t);  
                })
                resolve(itemList);
              });
            } else { // no more container
              resolve(itemList);
            }
          } else {
            reject(new Error('no obj element'));
          }
        }
      });
    });
  }

  browseAllChildrenRecursively(objectID)
  .then(function(items) {
    callback(null, items);
  }, function(err) {
    callback(err);
  });
}


function parseUPnPTime(str) {
  var temp = str.split(':');
  if(temp.length === 0) {
    return 0;
  }
  var h = Number(temp[0]);
  var m = Number(temp[1]);
  temp = temp[2].split('.');
  var s = Number(temp[0]);
  return h*3600 + m*60 + s;
}

function convertUPnPTime(time) {
  let t = Math.round(time);
  let h = t % 3600;
  t = t - h*3600;
  let m = t % 60;
  t = t - m*60;
  m = m.toString();
  if(m.length < 2) m = '0' + m;
  t = t.toString();
  if(t.length < 2) t = '0' + t;
  return h + ':' + m + ':' + t;
}

function convertInnerDIDL(item) {
  var temp = {};
  temp.id = item['$']['id']; // backward compatibility
  temp.objectID = temp.id;
  if(item['dc:title']) temp.name = item['dc:title'][0];
  if(item['dc:creator']) temp.creator = item['dc:creator'][0];
  if(item['upnp:artist']) temp.artist = item['upnp:artist'][0];
  if(item['dc:date']) temp.date = item['dc:date'][0];
  if(item['upnp:album']) temp.album = item['upnp:album'][0];
  if(item['upnp:genre']) temp.genre = item['upnp:genre'][0];
  if(item['upnp:originalTrackNumber']) temp.trackNumber = item['upnp:originalTrackNumber'][0];
  if(item['upnp:albumArtURI']) {
    var albumTmp = item['upnp:albumArtURI'][0];
    if(albumTmp['_']) {
      temp.albumArtURI = albumTmp['_'];
    } else {
      temp.albumArtURI = albumTmp;
    }
  }
  if(item['res']) {
    var res = item['res'][0];
    temp.file = res['_'];
    if(res['$'] && res['$']['duration']) {
      var duration = parseUPnPTime(res['$']['duration']);
      if(duration > 0) {
        temp.duration = duration;
      }
    }
  }
  return temp;
}

function parseRawDIDLItem(didl, callback) {
  var parseXML = require('xml2js').parseString;
  parseXML(didl, {explicitArray: true}, function(err, parsedData) {
    if(err) {
      callback(new Error(err));
    } else {
      if(parsedData && parsedData['DIDL-Lite'] && parsedData['DIDL-Lite']['item'] && parsedData['DIDL-Lite']['item'].length) {
        var returnObj = parsedData['DIDL-Lite']['item'][0];
        returnObj = convertInnerDIDL(returnObj);
        callback(null, returnObj);
      } else {
        callback(new Error("Problem with UPnP response"));
      }
    }
  });
}

function checkIfDeviceDescriptionExists(url, callback) {
  var opts = urlLib.parse(url);
  // opts.method = 'HEAD';
  var req = http.get(opts, function(r) {
    callback(r.statusCode == 200);
  });
  req.on('error', function(err) {
    callback(false);
  });
  req.end();
}

module.exports = {
  MediaBrowser: MediaBrowser,
  convertInnerDIDL: convertInnerDIDL,
  parseRawDIDLItem: parseRawDIDLItem,
  parseUPnPTime: parseUPnPTime,
  convertUPnPTime: convertUPnPTime,
  checkIfDeviceDescriptionExists: checkIfDeviceDescriptionExists
}
