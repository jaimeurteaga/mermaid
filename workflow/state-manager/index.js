var _ = require("lodash");
var logger = require("../../../../logger");
var utils = require("../../utils");
var config = require("../../../../../config");
var Q = require("q");
var Hooks = require("./hooks");
var Helpers = require("./helpers");

var _getParser = function(type) {

    /*
       TODO: What's the performance implications of doing a require each time
       We should be Lazy Loading here...
    */

    try {
        var Parser = require("./templates/" + type);
    } catch (e) {
        throw new Error("There was no template for type: `" + type + "`");
    }

    var parser = new Parser();

    return parser;

};

var _getInfo = function(base_data, opts) {

    var info = [];

    if (_.indexOf(opts["$omit"], "info") !== -1) {
        return info;
    } else {
        info = _.isString(base_data["info"]) ? [base_data["info"]] : base_data["info"];
    }

    return info;

};

var StateManager = function(controller, workflowController, bot, message, commandsForPatternCatcher) {

    var self = this;

    self.app = workflowController.app;
    self.controller = controller;
    self.workflowController = workflowController;
    self.bot = bot;
    self.message = message;
    self.commandsForPatternCatcher = commandsForPatternCatcher;
    self.service = utils.getService(bot);
    self.userId = utils.getUserId(this.service, this.message.user)
};


StateManager.prototype.init = function(base_data, options) {

    var deferred = Q.defer();

    var self = this;

    self.context = {};

    _.extend(self.context, base_data);

    self.context.info = _getInfo(base_data, options);

    self.context.service = self.service;

    var optionsHelper = new Helpers.Options(self),
        queryHelper = new Helpers.Query(self),
        memoryHelper = new Helpers.Memory(self),
        userService = self.workflowController.app.service("/v1/users");

    userService.update(self.userId, {
            'system.current_uri': self.context.uri
        })
        .then(function(user) {
            logger.info("Adding user to state: %s", JSON.stringify(user, null, 4))
            self.context.user = user;
        })
        .then(queryHelper.getDataForQuery.bind(queryHelper))
        .then(function(data) {
            logger.info("Adding data from query to state: %s", JSON.stringify(data, null, 4))
            _.extend(self.context, data);
        })
        .then(optionsHelper.getOptions.bind(optionsHelper))
        .then(function(options) {
            logger.debug("Processed options: %s", JSON.stringify(options, null, 4));
            self.context.options = options;
        })
        .then(optionsHelper.getUriPayloadHash.bind(optionsHelper))
        .then(function(uriPayloadHash) {
            logger.debug("uriPayloadHash: %s", JSON.stringify(uriPayloadHash, null, 4));
            self.context.uriPayloadHash = uriPayloadHash;
        })
        .then(memoryHelper.getMemory.bind(memoryHelper))
        .then(function(memory) {
            logger.debug("Setting memory: %s", JSON.stringify(memory, null, 4));
            self.context.memory = memory;
            deferred.resolve();
        })
        .catch(function(err) {
            logger.error("Failed in StateManager init: %s", err);
            deferred.reject(err);
        });


    return deferred.promise;

};


StateManager.prototype.messagesGenerator = function(convo) {

    var self = this;

    var parser = _getParser(self.context.type);

    var messages = parser.getMessages(self, convo);

    messages = _.map(messages, function(message) {

        if (message.text) {

            message.text = utils.injectVariables(message.text, self.context);

            return message;

        } else {
            return message;
        }

    });

    logger.debug("Messages: %s", JSON.stringify(messages, null, 4));

    return messages;
};

StateManager.prototype.infoGenerator = function(convo) {

    var self = this;

    logger.debug("Info before going into generator: %s", JSON.stringify(self.context.info, null, 4));

    var info = _.map(self.context.info, function(message) {

        if (_.isObject(message)) {
            return message;
        } else {
            return { text : utils.injectVariables(message, self.context) };
        }


    });

    logger.debug("Info after going into generator: %s", JSON.stringify(info, null, 4));

    return info;
};

StateManager.prototype.postInfoGenerator = function() {
    return this.context['post-info'];
};



StateManager.prototype.patternCatcherGenerator = function() {

    var self = this;

    var parser = _getParser(self.context.type);

    logger.info("Using %s parser.", self.context.type);

    var patternCatcher = parser.getPatternCatcher(self);

    patternCatcher = patternCatcher.concat(self.commandsForPatternCatcher);

    return patternCatcher;

};

StateManager.prototype.getURIForResponse = function(response) {

    var self = this;

    var parser = _getParser(self.context.type);

    var uri = parser.getURIForResponse(self, response);

    logger.debug("URIForReponse: %s", uri);

    return uri;

};

StateManager.prototype.getEnd = function(callback) {


    var parser = _getParser(this.context.type);

    var callback = callback || ((err, uri) => {

        if (err) {
            logger.error(err);
        }

        this.workflowController.route(uri);
    });

    var end = parser.getEnd(this, callback);

    //Apply Hooks

    if(this.context["after-hooks"]){
      var afterHooks = this.context["after-hooks"];
      var hooks = new Hooks(this.app, this.context, afterHooks);

      end = hooks.wrapFn(end);

    }

    return end;
};

StateManager.prototype.parse = function(convo, callback) {

    return {
        messages: this.messagesGenerator(convo),
        pattern_catcher: this.patternCatcherGenerator(),
        info: this.infoGenerator(convo),
        post_info: this.postInfoGenerator(),
        end: this.getEnd(callback)
    };


};

StateManager.prototype.getUri = function() {

    return this.context["uri"];

};

StateManager.prototype.getNextUri = function() {

    return this.context["next-uri"];

};

StateManager.prototype.isFinalMessage = function() {

    return this.context.final;
}

StateManager.prototype.isContainer = function() {

    var self = this;

    return self.context.type === "container";
}

module.exports = StateManager;