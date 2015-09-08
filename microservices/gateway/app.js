var http = require('http');
var url = require('url');
var jwt = require('jsonwebtoken');
var mongoose = require('mongoose');
var winston = require('winston');
var morgan = require('morgan');
var sprintf = require('sprintf');
var Q = require('q');
var _ = require('underscore');

// Logging
winston.emitErrs = true;
var logger = new winston.Logger({
    transports: [
        new winston.transports.Console({
            timestamp: true,
            level: process.env.GATEWAY_LOG_LEVEL || 'debug',
            handleExceptions: true,
            json: false,
            colorize: true
        })
    ],
    exitOnError: false
});

logger.stream = {
    write: function(message, encoding) {
        logger.debug(message.replace(/\n$/, ''));
    }
};

var httpLogger = morgan('combined', { stream: logger.stream });

function toBase64(obj) {
    return new Buffer(JSON.stringify(obj)).toString('base64');
}

var userDb = mongoose.connect(process.env.USER_DB_URL || '');
var servicesDb = mongoose.connect(process.env.SERVICES_DB_URL || '');

// Mongoose user model
var User = userDb.model('User', new Schema ({
    username: String,
    password: String,
    roles: [ String ]
}));

var Service = servicesDb.model('Service', new Schema ({
    name: String,
    url: String,
    endpoints: [ {
        type: String,
        url: String
    } ],
    authorizedRoles: [ String ]
}));

var secretKey = "super secret jwt key";
var issuerStr = "Sample API Gateway"

function send401(res) {
    res.statusCode = 401;
    res.end();
}

function doLogin(req, res) {
    req.on('data', function(chunk) {
        try {
            var loginData = JSON.parse(chunk);
            //FIX ME: use DB
            var user = users[loginData.username];
            if(user && user.password === loginData.password) {
                var token = jwt.sign({}, secretKey, {
                    subject: user.username,
                    issuer: issuerStr
                });
                
                res.writeHeader(200, {
                    'Content-Length': token.length,
                    'Content-Type': "text/plain"
                });
                res.write(token);
                res.end;                
            } else {
                send401(res);
            }
        } catch(err) {
            logger.error(err);
            
            send401(res);
        }
    });
}

function validateAuth(data, callback) {
    if(!data) {
        callback(null);
        return;
    }
    
    data = data.split(" ");
    if(data[0] !== "Bearer" || !data[1]) {
        callback(null);
        return;
    }
    
    var token = data[1];    
    try {
        var payload = jwt.verify(token, secretKey);
        // Custom validation logic, in this case we just check that the 
        // user exists
        var user = users[payload.sub];
        User.findOne({ username: payload.sub }, function(err, user) {
            if(err) {
                logger.error(err);
            } else {
                callback({
                    user: user,
                    jwt: payload 
                });
            }
        });                
    } catch(err) {
        logger.error(err);
        callback(null);
    }
}

function httpPromise(req, endpoint) {
    var result = Q.defer();
    
    function reject(msg) {
        result.reject({
            req: req, 
            endpoint: endpoint, 
            message: msg
        });
    }
    
    if(req.method !== 'POST') {
        reject('Unsupported HTTP method: ' + req.method);
        return result.promise;
    }
    
    //TODO
    
    return result.promise;
}

function serviceDispatch(req, res) {
    var parsedUrl = url.parse(req.url);
    
    Service.findOne({ url: parsedUrl.pathname }, function(err, service) {
        var authorized = checkAccess(service, req.context.authPayload);
        if(!authorized) {
            send401(res);
            return;
        }
        
        //Agreggation strategy for multiple endpoints.
        var promises = [];
        service.endpoints.forEach(function(endpoint) {
            switch(endpoint.type) {
                case 'http':
                    promises.push(httpPromise(req, endpoint));
                    break;
                case 'amqp':
                    promises.push(amqpPromise(req, endpoint));
                    break;
                default:
                    logger.error('Unknown endpoint type: ' + endpoint.type);
            }
        });
        
        Q.allSettled(promises).then(function(results) {
            var responseData = {};
        
            results.forEach(function(result) {
                if(result.state === 'fulfilled') {
                    responseData = _.extend(responseData, result.value);
                } else {
                    logger.error(result.reason.message);
                }
            });
            
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(responseData));
        });
    });
}

var server = http.createServer(function(req, res) {
    httpLogger(req, res, function(){});

    // Login endpoint
    if(req.url === "/login" && req.method === 'POST') {
        doLogin(req, res);
        return;
    }

    // Authentication
    var authHeader = req.headers["authorization"];
    validateAuth(authHeader, function(authPayload) {
        if(!authPayload) {
            send401(res);
            return;
        }
        
        // We keep the authentication payload to pass it to 
        // microservices decoded.
        req.context.authPayload = authPayload;
        
        serviceDispatch(req, res);        
    });
});

logger.info("Listening on port 3000");
server.listen(3000);



