const mongoose = require('mongoose');
const service = require('feathers-mongoose');
const Group = require('../../models/group');
var hooks = require("feathers-hooks");
var _ = require("lodash");

module.exports = function() {
    const app = this;

    app.use('/v1/groups', service({
        name: 'group',
        Model: Group,
        paginate: {
            default: 100,
            max: 100
        },
        overwrite : false
    }));

    // Get our initialize service to that we can bind hooks
    const groupService = app.service('/v1/groups');

    // Set up our before hooks
    groupService.after({
        all: [service.hooks.toObject()]
    });

};
