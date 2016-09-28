var events = require('events');

/*
Data Object
event : message context
data : message content
 */

var Data = function(event, data){
  this.event = event;
  this.data = data;
};

/*
PeerInfo Object
Informations about remote peer
connection : connection between the current and the remote peer
replicaNumber : replica number of the remote peer
 */

var PeerInfo = function(id){
  this.id = id;
  this.replicaNumber = null;
};

PeerInfo.prototype.setReplicaNumber = function(replicaNumber){
  this.replicaNumber = replicaNumber;
};

/*
PeerIOAdapter Object
Initialize and manage web p2p network
 */

var PeerIOAdapter = function(coordinator, signaling){
  var peerIOAdapter = this;

  this.coordinator = coordinator; // coordinator of the current peer
  this.webChannel = new netflux.WebChannel({signaling: signaling}); //the main object of Netflux.js which replaces this.peer
  this.peers = []; // Array[PeerInfo]
  this.reconnect = false;
  this.socketServer = null;
  this.connectionCreated = false;
  this.infosUsersModule = null;
  this.disposed = false;
  this.joinDoc = false;
  this.first = false;
  this.replicaNumber = null; //replica number of the current peer
  this.username = null; //username of current peer
  this.defaultInfoUsers = null; //defaultInfosUsers genrated at the connection initialization

  this.coordinator.on('initNetwork', function (data) {
    if(peerIOAdapter.disposed === false) {
      peerIOAdapter.toOnlineMode();
    }
  });

  this.coordinator.on('queryDoc', function (data) {
    if(peerIOAdapter.disposed === false) {
      data.username = peerIOAdapter.infosUsersModule.getUsername();
    }
  });

  this.coordinator.on('coordinatorDisposed', function (data) {
    if(peerIOAdapter.disposed === false) {
      peerIOAdapter.onCoordinatorDisposedHandler(data);
    }
  });
  this.coordinator.on('doc', function (args){
    //Give a copy of the document
    msg = {
      ropes: args.ropes,
      history: args.history,
      bufferLogootSOp: args.bufferLogootSOp,
      creationDate: args.creationDate,
      lastModificationDate: args.lastModificationDate
    };
    var data = JSON.stringify(new Data('sendDoc', msg));
    peerIOAdapter.webChannel.sendTo(args.callerID, data);
  });


  this.coordinator.on('initDoc', function (args){
    msg = {
      ropes: args.ropes,
      history: args.history,
      bufferLogootSOp: args.bufferLogootSOp,
      creationDate: args.creationDate,
      lastModificationDate: args.lastModificationDate
    };
    peerIOAdapter.emit('receiveDoc', msg);
  });
};

PeerIOAdapter.prototype = Object.create(events.EventEmitter.prototype);


PeerIOAdapter.prototype.setInfosUsersModule = function(infosUsers){
  var peerIOAdapter = this;
  this.infosUsersModule = infosUsersModule;

  infosUsersModule.on('changeLocalCursorAndSelections', function (data) {
    data.replicaNumber = peerIOAdapter.replicaNumber;
    if(peerIOAdapter.disposed === false) {
      var newData = JSON.stringify(new Data('broadcastCollaboratorCursorAndSelections', data));
      peerIOAdapter.webChannel.send(newData);
    }
  });

  infosUsersModule.on('changeLocalUsername', function (data) {
    data.replicaNumber = peerIOAdapter.replicaNumber;
    peerIOAdapter.username = data.username
    if(peerIOAdapter.disposed === false && peerIOAdapter.webChannel.channels.size !== 0) {
      var newData = JSON.stringify(new Data('broadcastCollaboratorUsername', data));
      peerIOAdapter.webChannel.send(newData);
    }
  });

};

PeerIOAdapter.prototype.handleEvent = function (args) {
  //manage data receiving
  try {
    var data = JSON.parse(args);
    if (data.event !== null && data.event !== undefined && this.disposed === false) {
      console.log('EVENT: ' + data.event, data)
      switch (data.event) {
        case 'sendOps':
          console.log('[Tracker-log] ' + args.length)
          data.data.replicaNumber = this.replicaNumber;
          this.emit('receiveOps', data.data);
          break;
        case 'sendDoc':
          data.data.replicaNumber = this.replicaNumber;
          data.data.infosUsers = this.defaultInfoUsers;
          this.emit('receiveDoc', data.data);
          this.emit('receiveDocPeer', data.data);
          break;
        case 'queryUserInfo':
          var remotePeerId = data.data.peerId;
          this.setReplicaNumber(remotePeerId, data.data.replicaNumber);
          this.emit('addUser', data.data.replicaNumber, data.data.username);
          data = {
              peerId : this.webChannel.myId,
              replicaNumber : this.replicaNumber,
              username : this.username
          };
          var msg = JSON.stringify(new Data('addUser', data));
          this.webChannel.sendTo(remotePeerId, msg);
          break;
        case 'addUser':
          this.setReplicaNumber(data.data.peerId, data.data.replicaNumber);
          this.emit('addUser', data.data.replicaNumber, data.data.username);
          this.emit('changeCollaboratorUsername', data.data);
          break;
        case 'broadcastCollaboratorCursorAndSelections':
          this.emit('changeCollaboratorCursorAndSelections', data.data);
          break;
        case 'broadcastCollaboratorUsername':
          this.emit('changeCollaboratorUsername', data.data);
          break;
        case 'broadcastParole':
          this.emit('receiveParole', data.data);
          break;
        case 'connect':
          this.emit('connect');
          break;
        case 'userJoin':
          this.emit('receiveUserJoin', data.data);
          break;
        case 'userLeft':
          this.emit('receiveUserLeft', data.data);
          break;
        case 'joinDoc':
          this.coordinator.giveCopy(data.data);
          break;
        default :
          console.log('handleEvent : ERROR !');
          break;
      }
    }
  } catch (e) {
    console.log('handleEvent error: ', e);
  }
};

PeerIOAdapter.prototype.whenPeerIdReady = function () {
  var userInfo = {
    peerId : this.webChannel.myId,
    replicaNumber : this.replicaNumber,
    username : this.username
  };
  this.webChannel.send(JSON.stringify(new Data('queryUserInfo', userInfo)));
  if (!this.joinDoc && !this.first) {
    this.joinDoc = true;
    this.webChannel.sendTo(this.peers[0].id, JSON.stringify(new Data('joinDoc', this.webChannel.myId)));
  }
};

PeerIOAdapter.prototype.toOnlineMode = function () {
  var peerIOAdapter = this;
  var connOptions = { 'sync disconnect on unload': true };

  this.socketServer = io.connect(location.origin, connOptions);
  /*
  You can use the signaling server set up on the mute server demo, to do that, you have just to uncomment the two following lines and comment the third
  WARNING : some troubles were encountred with firefox browser
  */
  //var peerServerId = Math.floor(Math.random()*100000).toString();
  //this.peer = new Peer(peerServerId, {host: '/', port: 8080, path: '/peerjs'}); //signaling server on mute demo server
  /* Netflux */
  this.webChannel.onJoining = function (id) {
    peerIOAdapter.peers.push(new PeerInfo(id));
  };
  this.webChannel.onLeaving = function (id) {
    peerIOAdapter.emit('removeUser', peerIOAdapter.getReplicaNumber(id));
    var peerToRemove = null;
    for (var i in peerIOAdapter.peers) {
      if (id === peerIOAdapter.peers[i].id) {
        peerToRemove = i
        break;
      }
    }
    if (peerToRemove !== null) {
      peerIOAdapter.peers.splice(peerToRemove, 1);
    }
  };
  this.webChannel.onMessage = function (id, msg) { peerIOAdapter.handleEvent(msg); };

  this.socketServer.on('connect', function() {
    var key = peerIOAdapter.webChannel.id + peerIOAdapter.webChannel.myId;
    var infoPeer = {
      docId : peerIOAdapter.coordinator.docID,
      key: key,
    };
    peerIOAdapter.socketServer.emit('newPeer', infoPeer);
  });

  this.socketServer.on('newPeerResponse', function (msg) {
    /* Receiving informations from server
        infoPeerIds = {
            replicaNumber //replica number of the current peer given by the server
            wcId: // webChannel id. If present, then you must join the webChannel, otherwise open for joining.
        }
     */
     if (!peerIOAdapter.reconnect) {
      peerIOAdapter.emit('connect');
      peerIOAdapter.replicaNumber = msg.replicaNumber;
      peerIOAdapter.username = "User " + peerIOAdapter.replicaNumber;
      peerIOAdapter.defaultInfoUsers = {};
      peerIOAdapter.defaultInfoUsers[peerIOAdapter.replicaNumber] = {
        cursorIndex: 0,
        selections: [],
        username: peerIOAdapter.username
      };

      var wc = peerIOAdapter.webChannel;
      if (msg.action === 'join') {
        // peerIOAdapter.joinWebChannel(0, msg.keys, msg.shouldOpen);
        wc.join(msg.keys[0])
          .then(function() {
            console.log('JOIN success')
            if (msg.shouldOpen) {
              wc.open({key: wc.id + wc.myId})
                .then(function (data) {
                  peerIOAdapter.socketServer.emit('key', {
                    docId: peerIOAdapter.coordinator.docID, key: wc.id + wc.myId
                  });
                });
            }
            peerIOAdapter.whenPeerIdReady();
          })
          .catch(function () {
            console.log('JOIN fail')
            var key = peerIOAdapter.webChannel.id + peerIOAdapter.webChannel.myId;
            peerIOAdapter.socketServer.emit('newPeer', {
              docId: peerIOAdapter.coordinator.docID,
              key: key
            });
          })
      } else if (msg.action === 'open') {
        wc.open({key: wc.id + wc.myId});
        peerIOAdapter.first = true;
        peerIOAdapter.joinDoc = true;
        peerIOAdapter.coordinator.giveCopy(null);

        var data = {
          replicaNumber: peerIOAdapter.replicaNumber,
          infosUsers: peerIOAdapter.defaultInfoUsers
        };
        peerIOAdapter.emit('receiveDocPeer', data);
        peerIOAdapter.whenPeerIdReady();
      }
    } else if (peerIOAdapter.webChannel.channels.size !== 0) {
      if (msg.shouldOpen) {
        var wc = peerIOAdapter.webChannel;
        wc.open({key: wc.id + wc.myId})
          .then(function (data) {
            peerIOAdapter.socketServer.emit('key', {
              docId: peerIOAdapter.coordinator.docID, key: wc.id + wc.myId
            });
          });
      }
    }
    peerIOAdapter.reconnect = true;
  });

  this.coordinator.on('operations', function (logootSOperations) {
    if(peerIOAdapter.disposed === false) {
      var obj = {
          'logootSOperations': logootSOperations,
          'lastModificationDate': new Date()
      };
      var data = new Data('sendOps', obj);
      peerIOAdapter.webChannel.send(JSON.stringify(data));
    }
  });

  this.coordinator.on('disconnect', function () {
    if(peerIOAdapter.disposed === false) {
      peerIOAdapter.toOfflineMode();
    }
  });

  this.connectionCreated = true;
  this.emit('connect');
};

PeerIOAdapter.prototype.joinWebChannel = function (index, keys, shouldOpen) {
  var peerIOAdapter = this;
  var wc = this.webChannel;
  wc.join(keys[index])
    .then(function() {
      if (shouldOpen) {
        wc.open({key: wc.id + wc.myId})
          .then(function (data) {
            peerIOAdapter.socketServer.emit('key', {
              docId: peerIOAdapter.coordinator.docID, key: wc.id + wc.myId
            });
          });
      }
      peerIOAdapter.whenPeerIdReady();
    })
    .catch(function () {
      if (index < keys.length - 1) {
        peerIOAdapter.joinWebChannel(++index, keys, shouldOpen)
      } else {
        var key = peerIOAdapter.webChannel.id + peerIOAdapter.webChannel.myId;
        peerIOAdapter.socketServer.emit('newPeer', {
          docId: peerIOAdapter.coordinator.docID,
          key: key
        });
      }
    });
}

PeerIOAdapter.prototype.addBot = function (url) {
  var wc = this.webChannel;
  wc.addBotServer(url)
    .then(function (id) {
      // wc.sendTo(id, JSON.stringify(new Data('updateReplicaNumber', )))
    })
    .catch(function () {
      console.error('Cound not add bot: ' + url)
    })
}

PeerIOAdapter.prototype.toOfflineMode = function () {
  if(this.socketServer !== null && this.socketServer !== undefined) {
    this.socketServer.disconnect();
    this.webChannel.leave();
    this.peers = [];
  }
};
PeerIOAdapter.prototype.send = function (logootSOperations) {
  var obj = {
    'logootSOperations': logootSOperations,
    'lastModificationDate': new Date()
  };
  this.webChannel.send(JSON.stringify(new Data('sendOps', obj)));
};

PeerIOAdapter.prototype.onCoordinatorDisposedHandler = function () {
  this.emit('networkDisposed');
  this.toOfflineMode();
  for (var key in this) {
    if (this.hasOwnProperty(key) === true) {
      if (key === 'disposed') {
        this.disposed = true;
      }
      else {
        this[key] = null;
      }
    }
  }
};

PeerIOAdapter.prototype.getPeer = function(peerId) {
  for (var i = 0; i < this.peers.length; i++) {
    if(this.peers[i].id === peerId){
      return this.peers[i];
    }
  }
  return null;
};

PeerIOAdapter.prototype.getReplicaNumber = function(peerId) {
  for (var i = 0; i < this.peers.length; i++) {
    if(this.peers[i].id === peerId){
      return this.peers[i].replicaNumber;
    }
  }
  return null;
};

PeerIOAdapter.prototype.setReplicaNumber = function(peerId, replicaNumber) {
  for (var i = 0; i < this.peers.length; i++) {
    if(this.peers[i].id === peerId){
      this.peers[i].setReplicaNumber(replicaNumber);
      break;
    }
  }
};

module.exports = PeerIOAdapter;
