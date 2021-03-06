var StateManager = require("./state-manager");
var url = require("url");
var qs = require('qs');
var logger = require("../logger");
var Messenger = require("../messenger");
var _ = require("lodash");
var qs = require("qs");
var deepExtend = require('deep-extend');
var async = require("async");
var request = require("request");
var ejs = require("ejs");
var dot = require("dot-object");
var utils = require("../utils");
var Q = require("q");
var Hooks = require("./state-manager/hooks");

var WorkflowController = function(app, controller, bot, message) {

    var self = this;

    this.app = app;
    this.controller = controller;
    this.bot = bot;
    this.message = message;
    this.messenger = new Messenger(app, bot, message);
    this.context = {
        responses: []
    };

};

WorkflowController.prototype.isStageComplete = function(stateManager) {

    var completedStages = stateManager.context.user.session && stateManager.context.user.session["completed-stages"];
    var currentUri = stateManager.context.uri;

    if (stateManager.context["storage-property"] && (!!dot.pick(stateManager.context["storage-property"], stateManager.context.user))) {
        return true;
    } else if (completedStages && completedStages.indexOf(currentUri) !== -1) {
        return true;
    } else {
        return false;
    }
}

WorkflowController.prototype.parseUri = function(uri) {

    //Custom unwrapping if the uri is in quotes

    if (uri.charAt(0) === "'" && uri.charAt(uri.length - 1) === "'") {
        uri = uri.substring(1, uri.length - 1);
    }

    var uri_obj = url.parse(uri);

    return {
        uri: uri_obj.pathname,
        query: uri_obj.query,
        options: qs.parse(uri_obj.query)
    }

};

WorkflowController.prototype.route = function(uri, overrides) {

    var deferred = Q.defer();

    overrides = overrides || {};

    var uriObj = this.parseUri(uri);

    if (uriObj.options.overrides) {
        overrides = _.extend(overrides, uriObj.options.overrides);
    }

    logger.info("Hit route: %s with options: %s", uriObj.uri, JSON.stringify(uriObj.options));

    return this.app.mermaid.getDataByURI(uriObj.uri).then((data) => {

        if (!data) {
            return logger.error("No route with this name: %s", uriObj.uri)
        }

        if (overrides) {
            data = Object.assign({}, data, overrides);
        }


        if (data.type === "ref") {
            return this.route(data["ref-uri"], data.overrides);
        }

        return this.runStageWithData(data, uriObj.options);

    }).catch((err) => {
        logger.error(err);
    })
};


WorkflowController.prototype.runStageWithData = function(data, options) {

    var deferred = Q.defer();

    var stateManager = new StateManager(this.controller, this, this.bot, this.message);

    stateManager.init(data, options).then(() => {

        logger.info("State manager init complete.");

        switch (stateManager.context.type) {
            case "api-call":
                this.handleApiCall(stateManager);
                break;
            case "update-data":
                this.handleUpdateData(stateManager, options);
                break;
            default:
                this.handleStage(stateManager);
                deferred.resolve();
        }

    }).catch((err) => {
        deferred.reject(err);
    })



    return deferred.promise;
}


WorkflowController.prototype.handleStage = function(stateManager, next) {


    var context_uri = stateManager.getUri(),
        isFinalMessage = stateManager.isFinalMessage(),
        isContainer = stateManager.isContainer(),
        nextURL = stateManager.getNextUri();

    if (this.isStageComplete(stateManager)) {
        return next ? next() : this.route(nextURL);
    }

    //Apply Hooks

    if (stateManager.context["before-hooks"]) {
        var beforeHooks = stateManager.context["before-hooks"];
        var hooks = new Hooks(this.app, stateManager.context, beforeHooks);
        hooks.run();
    }

    if (isContainer) {

        this.messenger.onStart(stateManager.infoGenerator(), context_uri);

        async.eachSeries(stateManager.context.objects, (data, next) => {

            // Add container uri to each child

            data = Object.assign(data, {
                uri: stateManager.context.uri
            });

            logger.debug("Data for child in container: %s", JSON.stringify(data, null, 4));

            stateManager.init(data, {}).then(() => {

                this.handleStage(stateManager, next);

            }).catch((error) => {
                logger.error(error);
            });

        }, () => {

            if (stateManager.context.post_info) {

                for (var i = 0, len = stateManager.context.post_info.length; i < len; i++) {

                    var text = stateManager.context.post_info[i];

                    this.reply({
                        text: text
                    }, context_uri);
                }
            }

            this.route(nextURL);
        })

    } else {

        var parts = stateManager.parse(next);

        if (isFinalMessage) {

            parts.messages.forEach((message) => {

                this.messenger.reply(message, context_uri);

            });

            if (stateManager.context.type === "redirect") {
                this.route(nextURL);
            }

            //Apply Hooks

            if (stateManager.context["after-hooks"]) {
                var afterHooks = stateManager.context["after-hooks"];
                var hooks = new Hooks(this.app, stateManager.context, afterHooks);
                hooks.run();
            }

        } else {

            this.bot.startConversation(this.message, (err, convo) => {

                if (err) {

                    logger.error(err);

                } else {


                    this.messenger.addConvo(convo);

                    this.messenger.onStart(parts.info, context_uri);

                    for (var i = 0; i < parts.messages.length; i++) {

                        var isLastMessage = i === parts.messages.length - 1;
                        var message = parts.messages[i];

                        if (isLastMessage) {

                            this.messenger.ask(message, parts.pattern_catcher, context_uri);

                        } else {

                            this.messenger.reply(message, context_uri);

                        }
                    }

                    this.messenger.onEnd(parts.post_info, parts.end, context_uri);

                }



            });

        }

    }


};

WorkflowController.prototype.handleUpdateData = function(stateManager, params) {

    var self = this;
    var base = stateManager.context["storage-property-base"] || "session";
    var updateQuery = {};
    var nextURL = stateManager.getNextUri();

    for (var key in params) {

        var updateKey = base + "." + key;
        var value = params[key];

        updateQuery[updateKey] = value;

    }

    self.app.service("/v1/users").update(stateManager.context.user.id, updateQuery, {}).then(function(user) {

        self.route(nextURL);

    }).catch(function(err) {
        logger.error(err);
    })

};

WorkflowController.prototype.handleApiCall = function(stateManager) {

    var data = {},
        systemKey,
        context_uri = stateManager.getUri(),
        method = stateManager.context.request.method,
        uri = utils.injectVariables(stateManager.context.request.uri, stateManager.context, this.app.config),
        nextURI = stateManager.getNextUri(),
        self = this;

    if (self.isStageComplete(stateManager)) {
        logger.debug("State is already complete, fowarding to: %s", nextURI);
        return self.route(nextURI);
    }

    for (var key in stateManager.context.request.data) {

        systemKey = stateManager.context.request.data[key];

        data[key] = dot.pick(systemKey, stateManager.context.user);
    }

    logger.debug("Sending %s call to %s with following data: %s ", method, uri, JSON.stringify(data, null, 4))

    request({
        method: method,
        uri: uri,
        json: true,
        headers: {
            "content-type": "application/json",
        },
        body: data
    }, function(err, httpResponse, body) {

        //TODO: Probably want to handle the error.status's in a more robust way

        logger.debug("Response from external system: %s", httpResponse)

        if (err || (body && body.status == 400 || body && body.status == 500)) {

            err = err || body.error;

            logger.error("Error making API request to external system: %s", err);

            return self.messenger.reply({
                text: "There was a error with our servers. Please type 'help' to talk directly to one of our operators."
            }, context_uri);

        }

        if (stateManager.context.response && stateManager.context.response['extract-data']) {

            var updateQuery = {};

            stateManager.context.response['extract-data'].forEach(function(transfer) {

                var source_key = transfer.source;
                var destination_key = transfer.destination;

                var value = body[source_key];

                updateQuery[destination_key] = value;


            });

            self.app.service("/v1/users").update(stateManager.context.user.id, updateQuery, {}).then(function(user) {

                self.route(nextURI);

            }).catch(function(err) {
                logger.error(err);
            })

        } else {
            self.route(nextURI);
        }


    });

};

module.exports = WorkflowController;
