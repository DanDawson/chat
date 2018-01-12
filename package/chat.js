var myVersion = "0.5.6", myProductName = "davechat"; 

exports.start = start;

const utils = require ("daveutils");
const davecache = require ("davecache");
const filesystem = require ("davefilesystem");
const request = require ("request");
const davetwitter = require ("davetwitter"); 
const websocket = require ("nodejs-websocket"); 
const fs = require ("fs");
const dns = require ("dns");
const os = require ("os");

var config = {
	httpPort: 1402,
	websocketPort: 1403,
	myDomain: "localhost",
	owner: undefined, //screenname of user who can admin the server
	blacklist: [
		],
	client: {
		flReadOnlyMode: false,
		productnameForDisplay: "json.chat",
		leadingQuestion: "What's for dinner?",
		editorPlaceholderText: "This is a good place for a (small) blog post."
		},
	twitter: {
		flLogToConsole: true,
		flForceTwitterLogin: true,
		twitterConsumerKey: undefined,
		twitterConsumerSecret: undefined
		},
	fnameChatlog: "data/chatlog.json",
	fnameStats: "data/stats.json",
	userDataFolder: "data/users/",
	archiveFolder: "data/archive/",
	fnamePrefs: "prefs.json",
	urlServerHomePageSource: "http://scripting.com/chat/code/template.html"
	};

var flAtLeastOneHitInLastMinute = false;

function getDomainName (clientIp, callback) { 
	if (clientIp === undefined) {
		if (callback !== undefined) {
			callback ("undefined");
			}
		}
	else {
		dns.reverse (clientIp, function (err, domains) {
			var name = clientIp;
			if (!err) {
				if (domains.length > 0) {
					name = domains [0];
					}
				}
			if (callback !== undefined) {
				callback (name);
				}
			});
		}
	}
function loadDataFile (f, callback) { 
	utils.sureFilePath (f, function () {
		fs.readFile (f, function (err, jsontext) {
			if (err) {
				console.log ("loadDataFile: error reading " + f + " == " + err.message);
				if (callback !== undefined) {
					callback (err);
					}
				}
			else {
				try {
					var jstruct = JSON.parse (jsontext);
					if (callback !== undefined) {
						callback (undefined, jstruct);
						}
					}
				catch (err) {
					console.log ("loadDataFile: error parsing " + f + " == " + err.message);
					if (callback !== undefined) {
						callback (err);
						}
					}
				}
			});
		});
	}
function saveDataFile (f, jstruct, callback) {
	utils.sureFilePath (f, function () {
		fs.writeFile (f, utils.jsonStringify (jstruct), function (err) {
			if (err) {
				console.log ("saveDataFile: error writing " + f + " == " + err.message);
				}
			if (callback !== undefined) {
				callback (err);
				}
			});
		});
	}

//websockets
	var theWsServer;
	
	function notifySocketSubscribers (verb, jstruct) {
		if (theWsServer !== undefined) {
			var ctUpdates = 0, now = new Date ();
			if (jstruct === undefined) {
				jstruct = {};
				}
			var jsontext = utils.jsonStringify (jstruct);
			for (var i = 0; i < theWsServer.connections.length; i++) {
				var conn = theWsServer.connections [i];
				if (conn.chatLogData !== undefined) { //it's one of ours
					try {
						conn.sendText (verb + "\r" + jsontext);
						conn.chatLogData.whenLastUpdate = now;
						conn.chatLogData.ctUpdates++;
						ctUpdates++;
						}
					catch (err) {
						console.log ("notifySocketSubscribers: socket #" + i + ": error updating");
						}
					}
				}
			}
		}
	function countOpenSockets () {
		if (theWsServer === undefined) { //12/18/15 by DW
			return (0);
			}
		else {
			return (theWsServer.connections.length);
			}
		}
	function getOpenSocketsArray () { //return an array with data about open sockets
		var theArray = new Array ();
		for (var i = 0; i < theWsServer.connections.length; i++) {
			var conn = theWsServer.connections [i];
			if (conn.chatLogData !== undefined) { //it's one of ours
				theArray [theArray.length] = {
					arrayIndex: i,
					lastVerb: conn.chatLogData.lastVerb,
					urlToWatch: conn.chatLogData.urlToWatch,
					domain: conn.chatLogData.domain,
					whenStarted: utils.viewDate (conn.chatLogData.whenStarted),
					whenLastUpdate: (conn.chatLogData.whenLastUpdate === undefined) ? "" : utils.viewDate (conn.chatLogData.whenLastUpdate),
					ctUpdates: conn.chatLogData.ctUpdates
					};
				}
			}
		return (theArray);
		}
	function handleWebSocketConnection (conn) { 
		var now = new Date ();
		
		function logToConsole (conn, verb, value) {
			getDomainName (conn.socket.remoteAddress, function (theName) { //log the request
				var freemem = utils.gigabyteString (os.freemem ()), method = "WS:" + verb, now = new Date (); 
				if (theName === undefined) {
					theName = conn.socket.remoteAddress;
					}
				console.log (now.toLocaleTimeString () + " " + freemem + " " + method + " " + value + " " + theName);
				conn.chatLogData.domain = theName; 
				});
			}
		
		conn.chatLogData = {
			whenStarted: now,
			whenLastUpdate: undefined,
			ctUpdates: 0
			};
		conn.on ("text", function (s) {
			var words = s.split (" ");
			if (words.length > 1) { //new protocol as of 11/29/15 by DW
				conn.chatLogData.lastVerb = words [0];
				switch (words [0]) {
					case "watch":
						conn.chatLogData.urlToWatch = utils.trimWhitespace (words [1]);
						logToConsole (conn, conn.chatLogData.lastVerb, conn.chatLogData.urlToWatch);
						break;
					}
				}
			else {
				conn.close ();
				}
			});
		conn.on ("close", function () {
			});
		conn.on ("error", function (err) {
			});
		}
	function webSocketStartup (thePort) {
		console.log ("webSocketStartup: thePort == " + thePort);
		try {
			theWsServer = websocket.createServer (handleWebSocketConnection);
			theWsServer.listen (thePort);
			}
		catch (err) {
			console.log ("webSocketStartup: err.message == " + err.message);
			}
		}
	function sendReloadMessage (screenname, callback) {
		if (screenname == config.owner) {
			notifySocketSubscribers ("reload");
			callback (undefined, {"message": "reload message sent to all websocket subscribers."});
			}
		else {
			callback ({message: "Can't send the message because the account is not authorized."});
			}
		}
//chatlog
	var theChatlog = {
		idNextPost: 0,
		messages: []
		};
	var flChatlogChanged = false;
	
	function chatlogChanged () {
		flChatlogChanged = true;
		}
	function OKToPost (screenname, callback) {
		if (config.flReadOnlyMode) { //11/26/16 by DW
			callback ({message: "Can't post because the server is in read-only mode."});
			return (false);
			}
		else {
			if (config.blacklist !== undefined) {
				var lowerscreenname = screenname.toLowerCase ();
				for (var i = 0; i < config.blacklist.length; i++) {
					if (config.blacklist [i].toLowerCase () == lowerscreenname) {
						callback ({message: "Can't post because the account is not authorized."});
						return (false);
						}
					}
				}
			return (true);
			}
		}
	function findChatlogItem (id) {
		for (var i = 0; i < theChatlog.messages.length; i++) {
			var item = theChatlog.messages [i];
			if (item.id == id) {
				return (i);
				}
			}
		return (-1);
		}
	function postToChatlog (jsontext, screenname, callback) {
		if (OKToPost (screenname, callback)) {
			try {
				var thePost = JSON.parse (jsontext);
				thePost.text = utils.decodeXml (thePost.text);
				thePost.id = theChatlog.idNextPost++;
				thePost.when = new Date ();
				thePost.screenname = screenname;
				theChatlog.messages.unshift (thePost);
				chatlogChanged ();
				notifySocketSubscribers ("update", thePost);
				if (callback !== undefined) {
					callback (undefined, thePost);
					}
				}
			catch (err) {
				if (callback !== undefined) {
					callback (err);
					}
				}
			}
		}
	function getChatlog (callback) {
		var chatlogSubset = {
			messages: []
			};
		for (var i = 0; i < theChatlog.messages.length; i++) {
			var item = theChatlog.messages [i], flInclude = true;
			if (item.flDeleted !== undefined) {
				if (item.flDeleted) {
					flInclude = false;
					}
				}
			if (flInclude) {
				chatlogSubset.messages.push (item);
				}
			}
		callback (chatlogSubset);
		}
	function updateChatlogItem (id, theText, screenname, callback) {
		if (OKToPost (screenname, callback)) {
			var now = new Date ();
			for (var i = 0; i < theChatlog.messages.length; i++) {
				var item = theChatlog.messages [i];
				if (item.id == id) {
					if (item.screenname == screenname) {
						item.text = theText;
						notifySocketSubscribers ("update", item);
						if (callback !== undefined) {
							callback (undefined, item); 
							}
						chatlogChanged ();
						return;
						}
					else {
						callback ({message: "Can't update because there is no message with the indicated id and author."});
						return;
						}
					}
				}
			callback ({message: "Can't update because there is no message with the indicated id."});
			}
		}
	function likeChatlogItem (id, screenname, callback) {
		if (OKToPost (screenname, callback)) {
			var now = new Date ();
			for (var i = 0; i < theChatlog.messages.length; i++) {
				var item = theChatlog.messages [i];
				if (item.id == id) {
					var fl = true;
					if (item.likes === undefined) {
						item.likes = new Object ();
						}
					if (item.likes [screenname] === undefined) {
						item.likes [screenname] = {
							when: now
							};
						}
					else {
						delete item.likes [screenname];
						fl = false;
						}
					notifySocketSubscribers ("update", item);
					if (callback !== undefined) {
						callback (undefined, fl); //return true if we liked, false if we unliked
						}
					chatlogChanged ();
					return;
					}
				}
			}
		}
	function deleteChatlogItem (id, screenname, callback) {
		if (OKToPost (screenname, callback)) {
			if (screenname == config.owner) {
				var ix = findChatlogItem (id);
				if (ix >= 0) {
					var item = theChatlog.messages [ix];
					item.flDeleted = true;
					chatlogChanged ();
					notifySocketSubscribers ("deleteItem", {id: id});
					callback (undefined, "deleted");
					}
				else {
					callback ({message: "Can't update because there is no message with the indicated id."});
					}
				}
			else {
				callback ({message: "Can't delete the item because the account is not authorized."});
				}
			}
		}
	function rolloverChatlog (screenname, callback) {
		if (screenname == config.owner) {
			var f = config.archiveFolder + "rollovers/chatlog" + utils.padWithZeros (stats.backupSerialNum++, 3) + ".json";
			saveDataFile (f, theChatlog, function (err) {
				if (err) {
					callback (err);
					}
				else {
					console.log ("rolloverChatlog: archived chatlog == " + f);
					theChatlog.idNextPost = 0;
					theChatlog.messages = [];
					statsChanged ();
					chatlogChanged ();
					notifySocketSubscribers ("rollover");
					callback (undefined, "rolled over");
					}
				});
			}
		else {
			callback ({message: "Can't rollover because the account is not authorized."});
			}
		}
	function readChatlog (callback) {
		loadDataFile (config.fnameChatlog, function (err, jstruct) {
			if (jstruct === undefined) { //force the initial file to be written
				chatlogChanged ();
				}
			else {
				theChatlog = jstruct;
				}
			if (callback !== undefined) {
				callback ();
				}
			});
		}
	function saveChatlogIfChanged (callback) {
		if (flChatlogChanged) {
			saveDataFile (config.fnameChatlog, theChatlog, callback);
			flChatlogChanged = false;
			}
		}
//stats
	var stats = {
		productName: myProductName,
		version: myVersion,
		
		ctServerStarts: 0,
		whenServerStart: undefined,
		ctHoursServerUp: 0,
		
		ctHits: 0, 
		ctHitsThisRun: 0,
		ctHitsToday: 0, 
		whenLastDayRollover: undefined,
		
		ctStatsSaves: 0,
		
		backupSerialNum: 0 //10/6/16 by DW
		};
	var flStatsChanged = false;
	
	function statsChanged () {
		flStatsChanged = true;
		}
	function readStats (callback) {
		loadDataFile (config.fnameStats, function (err, jstruct) {
			if (jstruct === undefined) { //force the initial file to be written
				statsChanged ();
				}
			else {
				for (var x in jstruct) {
					stats [x] = jstruct [x];
					}
				}
			if (callback !== undefined) {
				callback ();
				}
			});
		}
	function getStats (callback) {
		stats.productName = myProductName;
		stats.version = myVersion;
		stats.ctSockets = countOpenSockets ();
		stats.ctHoursServerUp = Number ((utils.secondsSince (stats.whenServerStart) / 3600).toFixed (3));
		stats.urlChatSocket = config.client.urlChatSocket;
		if (callback !== undefined) {
			callback (stats);
			}
		}
	function saveStats (callback) {
		getStats (); //set dynamic stats
		stats.ctStatsSaves++; 
		fs.writeFile (config.fnameStats, utils.jsonStringify (stats), callback);
		}
//prefs
	function getPrefs (screenname, callback) {
		var f = config.userDataFolder + screenname + "/" + config.fnamePrefs;
		loadDataFile (f, function (err, jstruct) {
			callback (err, jstruct);
			});
		}
	function savePrefs (screenname, jsontext, callback) {
		var f = config.userDataFolder + screenname + "/" + config.fnamePrefs;
		try {
			saveDataFile (f, JSON.parse (jsontext), callback);
			}
		catch (err) {
			callback (err);
			}
		}

function handleHttpRequest (theRequest) {
	var now = new Date ();
	var token = (theRequest.params.oauth_token !== undefined) ? theRequest.params.oauth_token : undefined;
	var secret = (theRequest.params.oauth_token_secret !== undefined) ? theRequest.params.oauth_token_secret : undefined;
	
	//stats
		stats.ctHits++;
		stats.ctHitsThisRun++;
		stats.ctHitsToday++;
		statsChanged ()
		
		flAtLeastOneHitInLastMinute = true;
	
	function returnPlainText (s) {
		theRequest.httpReturn (200, "text/plain", s.toString ());
		}
	function returnData (jstruct) {
		if (jstruct === undefined) {
			jstruct = {};
			}
		theRequest.httpReturn (200, "application/json", utils.jsonStringify (jstruct));
		}
	function returnHtml (htmltext) {
		theRequest.httpReturn (200, "text/html", htmltext);
		}
	function returnNotFound () {
		theRequest.httpReturn (404, "text/plain", "Not found.");
		}
	function returnError (jstruct) {
		theRequest.httpReturn (500, "application/json", utils.jsonStringify (jstruct));
		}
	function httpReturn (err, jstruct) {
		if (err) {
			returnError (err);
			}
		else {
			returnData (jstruct);
			}
		}
	function returnServerHomePage () {
		request (config.urlServerHomePageSource, function (error, response, templatetext) {
			if (!error && response.statusCode == 200) {
				var pagetable = {
					config: utils.jsonStringify (config.client),
					title: config.client.productnameForDisplay,
					version: myVersion
					};
				var pagetext = utils.multipleReplaceAll (templatetext, pagetable, false, "[%", "%]");
				returnHtml (pagetext);
				}
			});
		}
	
	function callWithScreenname (callback) {
		davetwitter.getScreenName (token, secret, function (screenname) {
			if (screenname === undefined) {
				returnError ({message: "Can't do the thing you want because the accessToken is not valid."});    
				}
			else {
				callback (screenname);
				}
			});
		}
	
	switch (theRequest.method) {
		case "POST":
			switch (theRequest.lowerpath) {
				case "/post": 
					callWithScreenname (function (screenname) {
						postToChatlog (theRequest.postBody, screenname, function (err, theResponse) {
							httpReturn (err, theResponse);
							});
						});
				}
		case "GET":
			switch (theRequest.lowerpath) {
				case "/version":
					returnPlainText (myVersion);
					return (true);
				case "/now":
					returnPlainText (now.toString ());
					return (true);
				case "/stats":
					getStats (function (response) {
						returnData (response);
						});
					return (true); 
				case "/getchatlog":
					getChatlog (function (response) {
						returnData (response);
						});
					return (true);
				case "/getmyscreenname":
					callWithScreenname (function (screenname) {
						returnPlainText (screenname);
						});
					return (true);
				case "/updatetext":
					callWithScreenname (function (screenname) {
						updateChatlogItem (theRequest.params.id, theRequest.params.text, screenname, function (err, response) {
							httpReturn (err, response);
							});
						});
					return (true); 
				case "/like":
					callWithScreenname (function (screenname) {
						likeChatlogItem (theRequest.params.id, screenname, function (err, response) {
							httpReturn (err, response);
							});
						});
					return (true); 
				case "/delete":
					callWithScreenname (function (screenname) {
						deleteChatlogItem (theRequest.params.id, screenname, function (err, response) {
							httpReturn (err, response);
							});
						});
					return (true); 
				case "/saveprefs":
					callWithScreenname (function (screenname) {
						savePrefs (screenname, theRequest.params.jsontext, function (err, response) {
							httpReturn (err, response);
							});
						});
					return (true); 
				case "/getprefs":
					callWithScreenname (function (screenname) {
						getPrefs (screenname, function (err, response) {
							httpReturn (err, response);
							});
						});
					return (true); 
				case "/getuserinfo":
					callWithScreenname (function (screenname) {
						davetwitter.getUserInfo (token, secret, screenname, function (err, theInfo) {
							httpReturn (err, theInfo);
							});
						});
					return (true); 
				case "/rollover":
					callWithScreenname (function (screenname) {
						rolloverChatlog (screenname, function (err, response) {
							httpReturn (err, response);
							});
						});
					return (true); 
				case "/reload":
					callWithScreenname (function (screenname) {
						sendReloadMessage (screenname, function (err, response) {
							httpReturn (err, response);
							});
						});
					return (true); 
				case "/":
					returnServerHomePage ();
					return (true); 
				}
			break;
		}
	
	return (false); //we didn't handle it
	}

function everyMinute () {
	var now = new Date (), timestring = now.toLocaleTimeString ();
	var ct = countOpenSockets (), countstring = ct + " open socket" + ((ct != 1) ? "s" : "");
	if (flAtLeastOneHitInLastMinute) {
		console.log ("");
		flAtLeastOneHitInLastMinute = false;
		}
	console.log (myProductName + " v" + myVersion + ": " + timestring + ", " + countstring + ".\n");
	if (!utils.sameDay (stats.whenLastDayRollover, now)) { //date rollover
		stats.whenLastDayRollover = now;
		stats.ctHitsToday = 0;
		statsChanged ();
		}
	if (flStatsChanged) {
		flStatsChanged = false;
		saveStats (function () {
			});
		}
	}
function everySecond () {
	saveChatlogIfChanged ();
	}
function start (options, callback) {
	var now = new Date ();
	function copyOptions () {
		function copyObject (source, dest) {
			for (x in source) {
				let val = source [x], type = typeof (val);
				if ((type == "object") && (val.constructor !== Array) && (!(val instanceof Date))) {
					if (dest [x] === undefined) {
						dest [x] = new Object ();
						}
					copyObject  (val, dest [x]);
					}
				else {
					dest [x] = val;
					}
				}
			}
		if (options !== undefined) {
			copyObject (options, config);
			}
		}
	
	copyOptions ();
	
	//some items in config are derived from others
		config.twitter.myDomain = config.myDomain + ":" + config.httpPort;
		config.twitter.httpPort = config.httpPort;
	
	console.log ("\n" + myProductName + " v" + myVersion + ", running on port " + config.httpPort + ".\n");
	console.log ("config == " + utils.jsonStringify (config));
	
	config.twitter.flPostEnabled = true; //we want davehttp to handle POST messages for us
	config.twitter.httpRequestCallback = handleHttpRequest; //we get first shot at all incoming HTTP requests
	
	davetwitter.start (config.twitter, function () {
		readChatlog (function () {
			readStats (function () {
				stats.ctServerStarts++;
				stats.whenServerStart = now; 
				stats.whenLastDayRollover = now; 
				stats.ctHitsThisRun = 0;
				statsChanged ();
				setInterval (everySecond, 1000); 
				utils.runAtTopOfMinute (function () {
					setInterval (everyMinute, 60000); 
					everyMinute ();
					});
				webSocketStartup (config.websocketPort); 
				davecache.start (undefined, function () {
					});
				});
			});
		});
	}
