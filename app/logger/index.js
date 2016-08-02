var config = require("../../config");

var winston = require('winston');
winston.emitErrs = true;

var logger = new winston.Logger({
    transports: [
        new winston.transports.Console({
            level: config.log_level,
            handleExceptions: false,
            json: false,
            colorize: true
        })
    ],
    exitOnError: false
});


module.exports = logger;
module.exports.stream = {
    write: function(message, encoding){
        logger.info(message);
    }
};
