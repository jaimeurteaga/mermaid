var _ = require("lodash");
var Utils = require("../../utils");
var logger = require("../../logger");
var Messenger = require("../../messenger");

var disableBotForUser = function(app, serviceType) {

    return function(bot, message, next) {

        logger.debug("Message: %s", JSON.stringify(message, null, 4));

        if (message.user && message.text) {

            var userId = Utils.getUserId(serviceType, message.user);

            app.service("/v1/users").get(userId).then((user) => {

                logger.debug("User %s: ", user);

                if (user && user.bot_disabled) {

                    logger.info("User %s is disabled with following message data: %s", message.user, JSON.stringify(message));

                    var messenger = new Messenger(app, bot, message);
                    messenger.recordMessageInDB(message, "received", null);

                } else {
                    next();
                }
            }).catch((e) => {
                logger.error("Error getting data : %s", e);
            })

        } else {
            next();
        }
    }
};

module.exports = disableBotForUser;
