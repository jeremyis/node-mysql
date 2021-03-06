var mysql          = require('../');
var Connection     = require('./Connection');
var EventEmitter   = require('events').EventEmitter;
var Util           = require('util');
var PoolConnection = require('./PoolConnection');

module.exports = Pool;

Util.inherits(Pool, EventEmitter);
function Pool(options) {
  EventEmitter.call(this);
  this.config = options.config;
  this.config.connectionConfig.pool = this;

  this._allConnections   = [];
  this._freeConnections  = [];
  this._connectionQueue  = [];
  this._closed           = false;
}

Pool.prototype.getConnection = function (cb) {

  if (this._closed) {
    return process.nextTick(function(){
      return cb(new Error('Pool is closed.'));
    });
  }

  var connection;

  if (this._freeConnections.length > 0) {
    connection = this._freeConnections.shift();

    return process.nextTick(function(){
      cb(null, connection);
    });
  }

  if (this.config.connectionLimit === 0 || this._allConnections.length < this.config.connectionLimit) {
    connection = new PoolConnection(this, { config: this.config.connectionConfig });

    this._allConnections.push(connection);

    return connection.connect(function(err) {
      if (this._closed) {
        return cb(new Error('Pool is closed.'));
      }
      if (err) {
        return cb(err);
      }

      this.emit('connection', connection);
      return cb(null, connection);
    }.bind(this));
  }

  if (!this.config.waitForConnections) {
    return process.nextTick(function(){
      return cb(new Error('No connections available.'));
    });
  }

  if (this.config.queueLimit && this._connectionQueue.length >= this.config.queueLimit) {
    return cb(new Error('Queue limit reached.'));
  }

  if (cb && process.domain)
    cb = process.domain.bind(cb);
  this._connectionQueue.push(cb);
};

Pool.prototype.releaseConnection = function (connection) {
  var cb;

  if (!connection._pool) {
    // The connection has been removed from the pool and is no longer good.
    if (this._connectionQueue.length) {
      cb = this._connectionQueue.shift();

      process.nextTick(this.getConnection.bind(this, cb));
    }
  } else if (this._connectionQueue.length) {
    cb = this._connectionQueue.shift();

    process.nextTick(cb.bind(null, null, connection));
  } else {
    this._freeConnections.push(connection);
  }
};

Pool.prototype.end = function (cb) {
  this._closed = true;

  if (typeof cb != "function") {
    cb = function (err) {
      if (err) throw err;
    };
  }

  var calledBack        = false;
  var closedConnections = 0;
  var connection;

  var endCB = function(err) {
    if (calledBack) {
      return;
    }

    if (err || ++closedConnections >= this._allConnections.length) {
      calledBack = true;
      return cb(err);
    }
  }.bind(this);

  if (this._allConnections.length === 0) {
    return process.nextTick(endCB);
  }

  for (var i = 0; i < this._allConnections.length; i++) {
    connection = this._allConnections[i];
    connection._realEnd(endCB);
  }
};

Pool.prototype.query = function (sql, values, cb) {
  if (typeof values === 'function') {
    cb = values;
    values = null;
  }

  if (!cb) {
    // Ignore results and errors if no cb supplied; matches connection.query
    cb = function () {};
  }

  var connection;
  var query = Connection.createQuery(sql, values, function (err, rows, fields) {
    connection.release();
    cb.apply(this, arguments);
  });

  if (this.config.connectionConfig.trace) {
    // Long stack trace support
    query._callSite = new Error;
  }

  this.getConnection(function (err, conn) {
    if (err) return cb(err);

    connection = conn;
    conn.query(query);
  });
};

Pool.prototype._removeConnection = function(connection) {
  var index;

  if ((index = this._allConnections.indexOf(connection)) !== -1) {
    // Remove connection from all connections
    this._allConnections.splice(index, 1);
  }

  if ((index = this._freeConnections.indexOf(connection)) !== -1) {
    // Remove connection from free connections
    this._freeConnections.splice(index, 1);
  }

  this.releaseConnection(connection);
};

Pool.prototype.escape = function(value) {
  return mysql.escape(value, this.config.connectionConfig.stringifyObjects, this.config.connectionConfig.timezone);
};
