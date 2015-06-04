var db = require('./db');
var config = require('./config');
var moment = require('moment');
var getReplayUrl = require('./getReplayUrl');
var fs = require('fs');
var request = require('request');
var domain = require('domain');
var JSONStream = require('JSONStream');
//var JSONStream = require('json-stream');
var constants = require('./constants.json');
var utility = require('./utility');
module.exports = function processParse(job, cb) {
    var match_id = job.data.payload.match_id;
    var match = job.data.payload;
    console.time("parse " + match_id);
    //get the replay url, update db
    getReplayUrl(match, function(err) {
        if (err) {
            return cb(err);
        }
        //match object should now contain replay url, also persisted to db
        if (match.parse_status === 1) {
            //expired, can't parse even if we have url, but parseable if we have a filename
            //TODO improve current socket test: we have no url in db and replay is expired on socket request, so that request fails!
            console.log("parse: replay expired");
            updateDb();
        }
        else {
            runParse(job, function(err, parsed_data) {
                if (err) {
                    console.log("match_id %s, error %s", match_id, err);
                    return cb(err);
                }
                match_id = match_id || parsed_data.match_id;
                job.data.payload.match_id = match_id;
                job.data.payload.parsed_data = parsed_data;
                job.data.payload.parse_status = 2;
                updateDb();
            });
        }

        function updateDb() {
            job.update();
            db.matches.update({
                match_id: match_id
            }, {
                $set: job.data.payload,
            }, function(err) {
                console.timeEnd("parse " + match_id);
                return cb(err);
            });
        }
    });
};

function runParse(job, cb) {
    console.log("[PARSER] parsing from %s", job.data.payload.url || job.data.payload.fileName);
    var inStream;
    var outStream;
    var exited;
    var error = "incomplete";
    var d = domain.create();
    //parse state
    var entries = [];
    var name_to_slot = {};
    var hero_to_slot = {};
    var game_zero = 0;
    var curr_teamfight;
    var teamfights = [];
    var intervalState = {};
    var teamfight_cooldown = 15;
    var parsed_data = utility.getParseSchema();
    //event handlers
    var streamTypes = {
        "state": function(e) {
            if (e.key === "PLAYING") {
                game_zero = e.time;
            }
            console.log(e);
        },
        "hero_log": function(e) {
            //get hero by id
            var h = constants.heroes[e.key];
            hero_to_slot[h ? h.name : e.key] = e.slot;
            //push it to entries for hero log
            entries.push(e);
        },
        "name": function(e) {
            name_to_slot[e.key] = e.slot;
        },
        "match_id": function(e) {
            parsed_data.match_id = e.value;
        },
        "error": function(e) {
            error = e.key;
            console.log(e);
        },
        "exit": function(e) {
            error = e.key;
            console.log(e);
        },
        "progress": function(e) {
            job.progress(e.key, 100);
            //console.log(e);
        }
    };
    var types = {
        "epilogue": function() {
            error = false;
        },
        "steam_id": function(e) {
            populate(e);
        },
        "hero_log": function(e) {
            populate(e);
        },
        "gold_reasons": function(e) {
            if (!constants.gold_reasons[e.key]) {
                //new gold reason
                //reason 8=cheat?
                console.log(e);
            }
            getSlot(e);
        },
        "xp_reasons": function(e) {
            if (!constants.xp_reasons[e.key]) {
                //new xp reason
                console.log(e);
            }
            getSlot(e);
        },
        "purchase": function(e) {
            getSlot(e);
            if (e.key.indexOf("recipe_") === -1) {
                e.type = "purchase_log";
                populate(e);
            }
        },
        "modifier_applied": getSlot,
        "modifier_lost": getSlot,
        "healing": getSlot,
        "ability_trigger": getSlot,
        "item_uses": getSlot,
        "ability_uses": getSlot,
        "kill_streaks": getSlot,
        "multi_kills": getSlot,
        "clicks": function(e) {
            //just 0 (other) the key for now since we dont know what the order_types are
            e.key = 0;
            getSlot(e);
        },
        "pings": function(e) {
            //we're not breaking pings into subtypes atm so just set key to 0 for now
            e.key = 0;
            getSlot(e);
        },
        "chat_event": function(e) {
            if (e.subtype === "CHAT_MESSAGE_RUNE_PICKUP") {
                //player
                e.type = "runes";
                populate(e);
            }
            else if (e.subtype === "CHAT_MESSAGE_HERO_KILL") {
                //player, assisting players
            }
            else if (e.subtype === "CHAT_MESSAGE_GLYPH_USED") {
                //team glyph
            }
            else if (e.subtype === "CHAT_MESSAGE_PAUSED") {
                //player paused
            }
            else if (e.subtype === "CHAT_MESSAGE_FIRSTBLOOD" || e.subtype === "CHAT_MESSAGE_TOWER_DENY" || e.subtype === "CHAT_MESSAGE_TOWER_KILL" || e.subtype === "CHAT_MESSAGE_BARRACKS_KILL" || e.subtype === "CHAT_MESSAGE_AEGIS" || e.subtype === "CHAT_MESSAGE_ROSHAN_KILL") {
                //objective
                //tower (player/team)
                //barracks (player)
                //aegis (player)
                //roshan (team)
                parsed_data.objectives.push(JSON.parse(JSON.stringify(e)));
            }
            else {
                //ignore rune bottling events
                if (e.subtype === "CHAT_MESSAGE_RUNE_BOTTLE") {}
                else {
                    console.log(e);
                }
            }
        },
        "kills": function(e) {
            getSlot(e);
            /*
            //logging objectives via combat log
            var logs = ["_tower", "_rax", "_fort", "_roshan"];
            var isObjective = logs.some(function(s) {
                return (e.key.indexOf(s) !== -1 && !e.target_illusion);
            });
            if (isObjective) {
                //push a copy to objectives
                parsed_data.objectives.push(JSON.parse(JSON.stringify(e)));
            }
            */
            if (e.target_hero && !e.target_illusion) {
                //log this hero kill
                e.type = "kills_log";
                populate(e);
                //check teamfight state
                curr_teamfight = curr_teamfight || {
                    start: e.time - teamfight_cooldown,
                    end: null,
                    last_death: e.time,
                    deaths: 0,
                    players: Array.apply(null, new Array(parsed_data.players.length)).map(function() {
                        return {
                            deaths_pos: {},
                            ability_uses: {},
                            item_uses: {},
                            kills: {},
                            deaths: 0,
                            buybacks: 0,
                            damage: 0
                        };
                    })
                };
                //update the last_death time of the current fight
                curr_teamfight.last_death = e.time;
                curr_teamfight.deaths += 1;
            }
            //reverse and log killed by
            //if the damaged unit isn't a hero, it won't be counted (no slot)
            //the key is a source, so it should be a hero
            var r = {
                time: e.time,
                unit: e.key,
                key: e.unit,
                type: "killed_by"
            };
            getSlot(r);
        },
        "damage": function(e) {
            //count damage dealt
            getSlot(e);
            //reverse and count as damage taken (see comment for reversed kill)
            var r = {
                time: e.time,
                unit: e.key,
                key: e.unit,
                value: e.value,
                type: "damage_taken"
            };
            getSlot(r);
            //check if hero hit
            if (e.target_hero && !e.target_illusion) {
                var h = {
                    time: e.time,
                    unit: e.unit,
                    key: e.inflictor,
                    type: "hero_hits"
                };
                getSlot(h);
                //biggest hit on a hero
                var m = {
                    type: "max_hero_hit",
                    time: e.time,
                    max: true,
                    inflictor: e.inflictor,
                    unit: e.unit,
                    key: e.key,
                    value: e.value
                };
                getSlot(m);
            }
        },
        "buyback_log": getSlot,
        "chat": function getChatSlot(e) {
            e.slot = name_to_slot[e.unit];
            //push a copy to chat
            parsed_data.chat.push(JSON.parse(JSON.stringify(e)));
        },
        "stuns": populate,
        "interval": function(e) {
            //store hero state at each interval for teamfight lookup
            if (!intervalState[e.time]) {
                intervalState[e.time] = {};
            }
            intervalState[e.time][e.slot] = e;
            //check curr_teamfight status
            if (curr_teamfight && e.time - curr_teamfight.last_death >= teamfight_cooldown) {
                //close it
                curr_teamfight.end = e.time;
                //push a copy for post-processing
                teamfights.push(JSON.parse(JSON.stringify(curr_teamfight)));
                //clear existing teamfight
                curr_teamfight = null;
            }
            if (e.time >= 0) {
                //if on minute, add to lh/gold/xp
                if (e.time % 60 === 0) {
                    e.interval = true;
                    e.type = "times";
                    e.value = e.time;
                    populate(e);
                    e.type = "gold";
                    e.value = e.gold;
                    populate(e);
                    e.type = "xp";
                    e.value = e.xp;
                    populate(e);
                    e.type = "lh";
                    e.value = e.lh;
                    populate(e);
                }
                e.interval = false;
                //add to positions
                if (e.x && e.y) {
                    e.type = "pos";
                    e.key = [e.x, e.y];
                    e.posData = true;
                    //not currently storing pos data
                    //populate(e);
                    if (e.time < 600) {
                        e.type = "lane_pos";
                        populate(e);
                    }
                }
            } else {
                //get lane position before time == 0
                e.type = "lane_pos";
                e.key = [e.x, e.y];
                e.posData = true;
                populate(e);
            }
        },
        "obs": function(e) {
            e.key = JSON.parse(e.key);
            e.posData = true;
            populate(e);
            e.posData = false;
            e.type = "obs_log";
            populate(e);
        },
        "sen": function(e) {
            e.key = JSON.parse(e.key);
            e.posData = true;
            populate(e);
            e.posData = false;
            e.type = "sen_log";
            populate(e);
        }
    };
    d.on('error', exit);
    d.run(function() {
        var url = job.data.payload.url;
        var fileName = job.data.payload.fileName;
        var target = job.parser_url + "&url=" + url + "&fileName=" + (fileName ? fileName : "");
        console.log("target:%s", target);
        inStream = request(target);
        //if (process.env.NODE_ENV!=="production") inStream.pipe(fs.createWriteStream("output.json"));
        outStream = JSONStream.parse();
        inStream.pipe(outStream);
        /*
        parser = spawn("java", ["-jar",
        "-Xmx64m",
        "parser/target/stats-0.1.0.one-jar.jar"
    ], {
            //we want want to ignore stderr if we're not dumping it to /dev/null from clarity already
            stdio: ['pipe', 'pipe', 'pipe'],
            encoding: 'utf8'
        });
        if (fileName) {
            inStream = fs.createReadStream(fileName);
            inStream.pipe(parser.stdin);
        }
        else if (url) {
            inStream = progress(request.get({
                url: url,
                encoding: null,
                timeout: 30000
            })).on('progress', function(state) {
                outStream.write(JSON.stringify({
                    "type": "progress",
                    "key": state.percent
                }));
            }).on('response', function(response) {
                if (response.statusCode !== 200) {
                    outStream.write(JSON.stringify({
                        "type": "error",
                        "key": response.statusCode
                    }));
                }
            });
            bz = spawn("bunzip2");
            inStream.pipe(bz.stdin);
            bz.stdout.pipe(parser.stdin);
        }
        else {
            throw new Error("no parse input");
        }
        parser.stderr.on('data', function(data) {
            console.log(data.toString());
        });
        parser.on('exit', function(code) {
            outStream.write(JSON.stringify({
                "type": "exit",
                "key": code
            }));
        });
        parser.stdout.pipe(outStream);
        */
        outStream.on('root', handleStream);
        outStream.on('end', function() {
            console.time("postprocess");
            processEventBuffer();
            processTeamfights();
            console.timeEnd("postprocess");
            //if (process.env.NODE_ENV !== "production") fs.writeFileSync("./output_parsed_data.json", JSON.stringify(parsed_data));
            exit(error);
        });
    });

    function exit(err) {
        if (!exited) {
            exited = true;
            //TODO: graceful shutdown
            //best is probably to have processparse running via cluster threads
            //then we can just crash this thread and master can respawn a new worker
            //we need to use kue's pause to stop processing jobs, then crash the thread
            //there is an API change in 0.9, so wait for that?
            console.log(err);
            cb(err.message || err, parsed_data);
        }
    }

    function handleStream(e) {
        if (streamTypes[e.type]) {
            streamTypes[e.type](e);
        }
        else {
            entries.push(e);
        }
    }

    function processEventBuffer() {
        for (var i = 0; i < entries.length; i++) {
            var e = entries[i];
            //adjust time by zero value to get actual game time
            e.time -= game_zero;
            if (types[e.type]) {
                types[e.type](e);
            }
            else {
                //no event handler for this type
                console.log("no event handler for type %s", e.type);
            }
        }
    }

    function processTeamfights() {
            //fights that didnt end wont be pushed to teamfights array (endgame case)
            //filter only fights where 3+ heroes died
            teamfights = teamfights.filter(function(tf) {
                return tf.deaths >= 3;
            });
            //go through teamfights, add gold/xp deltas
            teamfights.forEach(function(tf) {
                tf.players.forEach(function(p, ind) {
                    //set gold/xp deltas here
                    //alternative: total gold/xp change events?  This omits passive gold income and is affected by sells, includes gold lost to death
                    p.xp_start = intervalState[tf.start][ind].xp;
                    p.xp_end = intervalState[tf.end][ind].xp;
                    p.gold_start = intervalState[tf.start][ind].gold;
                    p.gold_end = intervalState[tf.end][ind].gold;
                    p.gold_delta = intervalState[tf.end][ind].gold - intervalState[tf.start][ind].gold;
                    p.xp_delta = intervalState[tf.end][ind].xp - intervalState[tf.start][ind].xp;
                });
            });
            for (var i = 0; i < entries.length; i++) {
                //loop over entries again
                var e = entries[i];
                //check each teamfight to see if this event should be processed as part of that teamfight
                for (var j = 0; j < teamfights.length; j++) {
                    var tf = teamfights[j];
                    if (e.time >= tf.start && e.time <= tf.end) {
                        //kills_log tracks only hero kills on non-illusions
                        if (e.type === "kills_log") {
                            //count toward kills
                            e.type = "kills";
                            populate(e, tf);
                            //get slot of target
                            e.slot = hero_to_slot[e.key];
                            //0 is valid value, so check for undefined
                            if (e.slot !== undefined) {
                                //if a hero dies, add to deaths_pos, lookup slot of the killed hero by hero name (e.key), get position from intervalstate
                                var x = intervalState[e.time][e.slot].x;
                                var y = intervalState[e.time][e.slot].y;
                                e.type = "deaths_pos";
                                e.key = [x, y];
                                e.posData = true;
                                populate(e, tf);
                                //increment death count for this hero
                                tf.players[e.slot].deaths += 1;
                            }
                        }
                        else if (e.type === "buyback_log") {
                            //bought back
                            tf.players[e.slot].buybacks += 1;
                        }
                        else if (e.type === "damage") {
                            //sum damage
                            //check if damage dealt to hero and not illusion
                            if (e.key.indexOf("npc_dota_hero") !== -1 && !e.target_illusion) {
                                //check if the damage dealer could be assigned to a slot
                                if (e.slot !== undefined) {
                                    tf.players[e.slot].damage += e.value;
                                }
                            }
                        }
                        else if (e.type === "ability_uses" || e.type === "item_uses") {
                            //count skills, items
                            populate(e, tf);
                        }
                        else {
                            continue;
                        }
                    }
                }
            }
            parsed_data.teamfights = teamfights;
        }
        /*
        //don't need this function with source/targetSource
            function assocName(name) {
                //given a name (npc_dota_visage_familiar...), tries to convert to the associated hero's name
                if (!name) {
                    return;
                }
                else if (name in hero_to_slot) {
                    return name;
                }
                else if (name.indexOf("illusion_") === 0) {
                    //associate illusions with the heroes they are illusions of
                    var s = name.slice("illusion_".length);
                    return s;
                }
                else if (name.indexOf("npc_dota_") === 0) {
                    //try to get the hero this minion is associated with
                    //split by _
                    var split = name.split("_");
                    //get the third element
                    var identifiers = [split[2], split[2] + "_" + split[3]];
                    for (var i = 0; i < identifiers.length; i++) {
                        var id = identifiers[i];
                        //append to npc_dota_hero_, see if matches
                        var attempt = "npc_dota_hero_" + id;
                        if (attempt in hero_to_slot) {
                            return attempt;
                        }
                    }
                }
                return name;
            }
        */
    function getSlot(e) {
        //with replay outputting sourceName and targetSourceName, merging/associating no longer necessary
        //e.unit should be populated with a valid hero for kill/damage
        //e.unit will be populated with the killed/damaged unit for killed/damaged (this may not be a hero, in that case e.slot will be undefined)
        //e.unit = assocName(e.unit);
        //if slot in event, use that, otherwise map value (could be undefined)
        //e.slot can be 0, so we check for existence in the object rather than !e.slot
        e.slot = ("slot" in e) ? e.slot : hero_to_slot[e.unit];
        populate(e);
    }

    function populate(e, container) {
        //use parsed_data by default if nothing passed in
        container = container || parsed_data;
        if (!container.players[e.slot]) {
            //couldn't associate with a player, probably attributed to a creep/tower/necro unit
            //console.log(e);
            return;
        }
        var t = container.players[e.slot][e.type];
        if (typeof t === "undefined") {
            //parsed_data.players[0] doesn't have a type for this event
            console.log(e);
            return;
        }
        else if (e.posData) {
            //fill 2d hash with x,y values
            var x = e.key[0];
            var y = e.key[1];
            if (!t[x]) {
                t[x] = {};
            }
            if (!t[x][y]) {
                t[x][y] = 0;
            }
            t[x][y] += 1;
        }
        else if (e.max) {
            //check if value is greater than what was stored
            if (e.value > t.value) {
                container.players[e.slot][e.type] = e;
            }
        }
        else if (t.constructor === Array) {
            //determine whether we want the value only (interval) or the time and key (log)
            //either way this creates a new value so e can be mutated later
            var arrEntry = (e.interval) ? e.value : {
                time: e.time,
                key: e.key
            };
            t.push(arrEntry);
        }
        else if (typeof t === "object") {
            //add it to hash of counts
            e.value = e.value || 1;
            t[e.key] ? t[e.key] += e.value : t[e.key] = e.value;
        }
        else if (typeof t === "string") {
            //string, used for steam id
            container.players[e.slot][e.type] = e.key;
        }
        else {
            //we must use the full reference since this is a primitive type
            //use the value most of the time, but key when stuns since value only holds Integers in Java
            //replace the value directly
            container.players[e.slot][e.type] = e.value || Number(e.key);
        }
    }
}