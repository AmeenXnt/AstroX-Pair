const mega = require('megajs');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const config = require('./config.cjs');

function generateUA() {
    var browsers = ['Chrome', 'Firefox', 'Safari', 'Edge'];
    var versions = ['91.0', '90.0', '89.0', '88.0'];
    var os = ['Windows NT 10.0', 'Macintosh; Intel Mac OS X 10_15_7', 'Linux; Ubuntu 20.04'];
    var browser = browsers[Math.floor(Math.random() * browsers.length)];
    var version = versions[Math.floor(Math.random() * versions.length)];
    var platform = os[Math.floor(Math.random() * os.length)];
    return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) ${browser}/${version} Safari/537.36`;
}

var upload = (filePath) => {
    return new Promise((resolve, reject) => {
        var auth = {
            email: config.EMAIL,
            password: config.PASS,
            userAgent: generateUA()
        };

        var fileName = `${crypto.randomBytes(5).toString('hex')}${path.extname(filePath)}`;

        var storage = new mega.Storage(auth, (err) => {
            if (err) return reject(err);

            var content = fs.readFileSync(filePath);

            var stream = storage.upload({
                name: fileName,
                size: content.length,
                allowUploadBuffering: true
            });

            stream.end(content);

            stream.on('complete', (file) => {
                file.link((err, url) => {
                    if (err) return reject(err);
                    resolve(url);
                });
            });

            stream.on('error', (error) => reject(error));
        });

        storage.on('error', (err) => reject(err));
    });
};

module.exports = { upload };
