const tls = require('tls');
const debug = require( 'debug' )( 'push-reciever:socket' );

const MCS_VERSION = 41;
const HOST = 'mtalk.google.com';
const PORT = 5228;
const RETRY_MAX_TEMPO = 15; // maximum time before retrying to open the socket (in seconds)
let retryCount = 0;         // retries count of opening socket attempts
const STATES = [ 'connecting', 'seenversion', 'loggedin' ];

let timer;

module.exports = {
  connect,
};

// Adapted from: https://github.com/chrisdickinson/varint/blob/master/decode.js
function readVarInt(buf, offset = 0) {
  const MSB = 0x80;
  const REST = 0x7F;

  let res    = 0;
  let shift  = 0;
  let counter = offset;
  let byte;

  do {
    if (counter >= buf.length) {
      throw new RangeError('Could not decode varint');
    }
    byte = buf[counter++];
    res += shift < 28
      ? (byte & REST) << shift
      : (byte & REST) * Math.pow(2, shift);
    shift += 7;
  } while (byte >= MSB);


  return {
    value : res,
    bytes : counter - offset,
  };
}

async function connect(
  loginRequest,
  protocol,
  notificationCallback,
  loginCallback,
) {
  // Retry on disconnect
  const retry = connect.bind(
    this,
    loginRequest,
    protocol,
    notificationCallback,
    loginCallback,
  );
  const socket = await connectSocket(retry);
  timer = process.hrtime();
  debug( 'MCS socket connected' );

  // Payload to send to login with MCS server
  const loginTag = protocol.find( tag => tag.name === 'LoginRequest');
  socket.write( Buffer.from( [
    MCS_VERSION,
    loginTag.tag,
  ] ) );
  socket.write( loginTag.type.encodeDelimited(loginRequest).finish() );

  // Listen for incoming messages
  listen(socket, protocol, notificationCallback, loginCallback);

  return {
    close : () => {
      socket._userClose = true;
      socket.destroy();
    },
  };
}

function connectSocket(retry) {
  return new Promise(resolve => {
    const socket = new tls.TLSSocket();
    socket.setKeepAlive(true);
    socket.on('close', () => {
      const diff = process.hrtime(timer);
      const minutes = Math.round((diff[0] + diff[1] / 1e9) / 60);
      const retryTempo = Math.min(retryCount++, RETRY_MAX_TEMPO);
      debug(`MCS socket closed after ${minutes} minutes`);

      if ( ! socket._userClose ) {
        debug(`Will try to reconnect in ${retryTempo} seconds`);
        setTimeout(() => retry(), retryTempo * 1000); 
      }
    });
    socket.on('error', error => {
      if (error.code === 'ECONNRESET') {
        debug('Connection to MCS server lost');
        return;
      }
      debug('Error while communicating with MCS server');
      debug(error);
    });
    socket.connect(
      {
        host : HOST,
        port : PORT,
      },
      () => {
        // eslint-disable-next-line no-param-reassign
        retryCount = 0; // Reset retry count on successful connection
        resolve(socket);
      }
    );
  });
}

function listen(socket, protocol, notificationCallback, loginCallback) {
  let prevBuffer = null;
  let state = STATES[0];
  socket.on('data', currentBuffer => {
    const buffer = prevBuffer ? Buffer.concat( [ prevBuffer, currentBuffer ] ) : currentBuffer;

    if (buffer.length === 1 && state === STATES[0]) {
      state = STATES[1];
      return;
    }

    try {
      const tagId = buffer.readUIntBE(0, 1);
      const sizeVarInt = readVarInt(buffer, 1);

      if ( buffer.length === sizeVarInt.value + 1 + sizeVarInt.bytes ) { // one byte tagId and one or more byte for size varint
        prevBuffer = null;
      } else {
        prevBuffer = buffer;
        return;
      }

      const currentTag = protocol.find(tag => tag.tag === tagId);

      if ( ! currentTag ) {
        debug('Unable to find tag id ' + tagId);
        return;
      }


      const msg = currentTag.type.decodeDelimited( buffer.slice(1) );

      debug( `Recieved ${ currentTag.name }: ${ JSON.stringify( msg ) }` );

      if (currentTag.name === 'DataMessageStanza') {
        if ( typeof notificationCallback === 'function' ) {
          process.nextTick( () => notificationCallback( msg ) );
        }
      }

      if (currentTag.name === 'LoginResponse') {
        //TODO: check actual response
        state = STATES[2];
        if ( typeof loginCallback === 'function' ) {
          process.nextTick( () => loginCallback( msg ) );
        }
      }

    } catch(e) {
      debug( `Error processing buffer ${ buffer.toString('hex') } of length: ${ buffer.length } error: ${ e }`);
    }
  } );

  return socket;
}
