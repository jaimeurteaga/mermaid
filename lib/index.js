var walkSync = require('walk-sync');
var path = require("path");
var logger = require("./logger");
var async = require("async");
var facebook = require("./lib/facebook");
var lighttunnel = require("./lib/lighttunnel");
var WorkflowController = require("./workflow");
var Messenger = require("./messenger");
var Q = require("q");
var mermaidConfig = require("./config");

var facebookRegistered = (process.env.FACEBOOK_PAGE_ID && process.env.FACEBOOK_PAGE_TOKEN && process.env.FACEBOOK_VERIFY_TOKEN);
var twilioRegistered = (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_NUMBER);
var slackRegistered = (process.env.SLACK_CLIENT_SECRET && process.env.SLACK_CLIENT_ID);


var findConvo = function(botkit, id) {

    var tasks = botkit.tasks;

    for (var i = 0; i < tasks.length; i++) {

        var task = tasks[i];

        var convos = task.convos;

        for (var j = 0; j < convos.length; j++) {

            var convo = convos[j];

            if (convo.id === id) {
                return convo;
            }
        }
    }

};

var getData = function(directory) {

    logger.info("Getting data from data directory: %s", directory);

    var data = {};

    var files = walkSync(directory);

    files.forEach(function(file) {

        if (path.extname(file) === ".json") {

            file = directory + "/" + file;

            var json = require(file);
            var uri = json.uri;

            data[uri] = json;
        }
    })

    return data;
}


var getValidators = function(localValidatorsDirectory) {

    var validators = {};

    var directories = [__dirname + "/workflow/state-manager/validator/templates"];

    if (localValidatorsDirectory) {
        directories.push(localValidatorsDirectory);
    }

    logger.info("Setting up validators...");

    directories.forEach(function(directory) {

        var files = walkSync(directory);

        files.forEach(function(file) {

            if (path.extname(file) === ".js") {

                file = directory + "/" + file;

                var validator = require(file);

                var name = path.basename(file, '.js')

                validators[name] = validator;
            }
        });


    });

    return validators;

}

var getTypes = function(localTypesDirectory) {

    logger.info("Setting up types...");

    var templates = {};

    var directories = [__dirname + "/workflow/state-manager/types"];

    if (localTypesDirectory) {
        directories.push(localTypesDirectory);
    }

    directories.forEach(function(directory) {

        var files = walkSync(directory);

        files.forEach(function(file) {

            if (path.extname(file) === ".js") {

                file = directory + "/" + file;

                var template = require(file);

                var name = path.basename(file, '.js')

                templates[name] = template;
            }
        });

    })

    return templates;

};

var getHooks = function(localHooksDirectory) {

    logger.info("Setting up hooks...");

    var hooks = {};

    var directories = [__dirname + "/workflow/state-manager/hooks/templates"];

    if (localHooksDirectory) {
        directories.push(localHooksDirectory)
    }

    directories.forEach(function(directory) {

        var files = walkSync(directory);

        files.forEach(function(file) {

            if (path.extname(file) === ".js") {

                file = directory + "/" + file;

                var hook = require(file);

                var name = path.basename(file, '.js')

                hooks[name] = hook;
            }
        });


    });

    return hooks;

};

var getCommands = function(pathname, app) {

    let commands = {};

    logger.info("Setting up commands...");

    if (pathname) {
        commands = require(pathname)(app);
    }

    return commands;


}

var setupFacebook = function(config) {

    var f = facebook(config)

    var setup_functions = Object.keys(f).map(function(key) {
        return f[key]
    });

    async.series(setup_functions, function(err, result) {
        if (err) {
            logger.error(err);
        } else {
            logger.info("Setup Facebook.");
        }
    });

};


module.exports = function(config) {

    if (!(facebookRegistered || twilioRegistered || slackRegistered)) {

        return logger.error("Please specify one of the following sets of environment variables: \n\n \
      Facebook - FACEBOOK_PAGE_ID, FACEBOOK_PAGE_TOKEN, FACEBOOK_VERIFY_TOKEN \n \
      Slack - SLACK_CLIENT_SECRET, SLACK_CLIENT_ID \n \
      Twilio - TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_NUMBER \n\n \
      🐬  Mermaid");

    }

    config = Object.assign({}, mermaidConfig, config);

    var services = {
        facebook: facebookRegistered,
        twilio: twilioRegistered,
        slack: slackRegistered
    };

    var app = require("./app")(config);

    app.mermaid = {};

    app.mermaid.methods = {};

    app.config = config;

    app.mermaid.data = getData(config.data_directory);

    app.mermaid.validators = getValidators(config.validators_directory);

    app.mermaid.types = getTypes(config.types_directory);

    app.mermaid.hooks = getHooks(config.hooks_directory);

    app.mermaid.commands = getCommands(config.commands_pathname, app);

    if (config.facebook) {
        setupFacebook(config);
    }
    
    Object.assign(app.mermaid.methods, {

        messageTeam: function(message) {
            var mailgun = require('mailgun-js')({
                apiKey: config.mailgun.apiKey,
                domain: config.mailgun.domain
            });

            var data = {
                to: config.admin_emails,
                from: 'No-Reply <noreply@mg.sagebots.com>',
                subject: config.company + ' Bot Alert',
                text: message
            };

            mailgun.messages().send(data, function(err, body) {
                if (err) {
                    logger.error("Error sending message using mailgun: %s", err);
                } else {
                    logger.info("E-mail sent to team.");
                }
            });
        }

    });

    /* Service Registration */

    Object.keys(services).forEach(function(serviceName) {

        var isActive = services[serviceName];

        if (isActive) {
            require("./services/" + serviceName)(app, config);
        }

    });

    app.mermaid.findConvo = function(id, service) {

        return findConvo(app.mermaid[service], id);

    };

    app.mermaid.hasConversationActive = function(user) {
        return !!user.last_botkit_message_obj.convo_id;
    }

    app.mermaid.getType = function(name) {
        return new app.mermaid.types[name]();
    }

    app.mermaid.getWorkflowControllerForUser = function(user) {

        var type = user.type;

        var controller = app.mermaid[type];

        var bot;

        if (type === "slack") {
            bot = controller.getBot(user.platform.team_id);
        } else {
            bot = controller.getBot()
        }

        return new WorkflowController(app, controller, bot, user.last_botkit_message_obj)

    }

    app.mermaid.getMessengerForUser = function(user) {

        var type = user.type;

        var controller = app.mermaid[type];

        var bot;

        if (type === "slack") {
            bot = controller.getBot(user.platform.team_id);
        } else {
            bot = controller.getBot()
        }

        return new Messenger(app, bot, user.last_botkit_message_obj);

    }

    app.mermaid.getDataByURI = function(uri) {
        var deferred = Q.defer();

        var data = app.mermaid.data[uri];

        if (data) {
            deferred.resolve(data)
        } else {
            deferred.reject("No data for that URI");
        }

        return deferred.promise;

    };

    app.mermaid.use = function(plugin) {

        plugin.setup.call(app);

        return app.mermaid;
    };

    return app.mermaid;

};
