const crypto = require('crypto');
const request = require('request-promise');
const { escape } = require('../../utils/base64');
const { saveKeys, saveFCM } = require('../../store');

const FCM_SUBSCRIBE = 'https://fcm.googleapis.com/fcm/connect/subscribe';
const FCM_ENDPOINT = 'https://fcm.googleapis.com/fcm/send';

module.exports = function registerFCM({ senderId, token, appId }) {
  return createKeys(appId, senderId)
    .then(saveKeys)
    .then(keys =>
      request({
        url     : FCM_SUBSCRIBE,
        method  : 'POST',
        headers : {
          'Content-Type' : 'application/x-www-form-urlencoded',
        },
        form : {
          authorized_entity : senderId,
          endpoint          : `${FCM_ENDPOINT}/${token}`,
          encryption_key    : keys.publicKey,
          encryption_auth   : keys.authSecret,
        },
      })
    )
    .then(saveFCM);
};

function createKeys(appId, authorizedEntity) {
  return new Promise((resolve, reject) => {
    const dh = crypto.createECDH('prime256v1');
    dh.generateKeys();
    crypto.randomBytes(16, (err, buf) => {
      if (err) {
        return reject(err);
      }
      return resolve({
        privateKey : escape(dh.getPrivateKey('base64')),
        publicKey  : escape(dh.getPublicKey('base64')),
        authSecret : escape(buf.toString('base64')),
        authorizedEntity,
      });
    });
  });
}