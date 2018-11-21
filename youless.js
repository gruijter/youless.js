/* eslint-disable prefer-destructuring */

'use strict';

const http = require('http');
const dns = require('dns');
// const util = require('util');

const defaultPort = 80;	// alternatives: 32848, 16464, 49232
const defaultPassword = '';
const defaultCookie = ['undefined'];
// const youlessMacId = '72:b8:ad:14';

// available for LS110 and LS120:
const loginPath = '/L?w=';
const homePath = '/H';	// home page, only works after login if password is set
const networkPath = '/N';	// network settings, only works after login if password is set
const basicStatusPath = '/a?f=j';
const setMeterTypePath = '/M?m='; // add a for analogue, d for digital e.g. /M?m=d
const setPowerCounterPath = '/M?k='; // add counter value. e.g. /M?c=12345
const setPowerPulsesPath = '/M?p='; // add pulses per kWh, e.g. /M?&p=1000
// const powerLogPath = '/V';	// add range h/w/d/m, selection, and json format. e.g. ?m=12&f=j
const syncTimePath = '/S?t=n';	// time will sync to unknown time server
const rebootPath = '/S?rb=';

// only available for LS120:
const discoverPath = '/d';
const advancedStatusPath = '/e';
// const gasLogPath = '/W';	// add range w/d/m, selection, and json format. e.g. ?d=70&f=j

//  Only available for LS120 fw>-1.4:
const setS0PulsesPath = '/M?s='; // add pulses per kWh, e.g. /M?&s=1000
const setS0CounterPath = '/M?c='; // add counter value. e.g. /M?c=12345
// const s0LogPath = '/Z';	// add range h/w/d/m, selection, and json format. e.g. ?h=1&f=j

const regExTimeResponse = /Tijd:<td>(.*?) \*<tr>/;
const regExModelResponse = /Model:<td>(.*?)<tr>/;
const regExFirmwareResponse = /Firmware versie:<td>(.*?)<tr>/;
const regExMacResponse = /MAC Adres:<td>(.*?)<tr>/;

function toEpoch(time) {	// yymmddhhmm, e.g. 1712282000 > 1514487600
	const tmString = time.toString();
	if (tmString.length !== 10) {
		// util.log('time has an invalid format');
		return 0;
	}
	const tm = new Date(`20${tmString.slice(0, 2)}`, Number(tmString.slice(2, 4)) - 1,
		tmString.slice(4, 6), tmString.slice(6, 8), tmString.slice(8, 10));
	return tm.getTime() / 1000 || 0;
}

/** Class representing a session with a youless device.
* @property {string} password - The login password.
* @property {string} host - The url or ip address of the device.
* @property {number} port - The port of the device.
* @property {number} timeout - http timeout in milliseconds.
* @property {boolean} loggedIn - login state.
* @example // create a youless session, login to device, fetch basic power info
	const Youless = require('youless');

	const youless = new Youless();

	async function getPower() {
		try {
			// fill in the password of the device. Use '' if no password is set in the device
			// fill in the ip address of the device, e.g. '192.168.1.50'
			// do not fill in an ip address if you want to autodiscover the device during login
			await youless.login('devicePassword', 'deviceIp');
			const powerInfo = await youless.getBasicInfo();
			console.log(powerInfo);
		} catch (error) {
			console.log(error);
		}
	}

	getPower();
	*/
class Youless {
	/**
	* Create a youless session.
	* @param {string} [password = ''] - The login password.
	* @param {string} [host] - The url or ip address of the router. Will be automatically discovered on first login.
	* @param {number} [port = 80] - The port of the device
	*/
	constructor(password, host, port) {
		this.password = password || defaultPassword;
		this.host = host;
		this.port = port || defaultPort;
		this.loggedIn = password === defaultPassword;
		this.cookie = defaultCookie;
		this.timeout = 4000;	// milliseconds for http request
		this.info = {
			model: undefined,			// will be filled automatically on login() for LS120, or on getInfo2() for LS110
			mac: undefined,				// will be filled automatically on login() for LS120, or on getInfo2() for LS110
			firmware: undefined,		// will be filled automatically on getInfo2()
			hasP1Meter: undefined,		// will be made true if p1 data is received in this session
			hasGasMeter: undefined,		// will be made true if gas data is received in this session
			hasS0Meter: undefined,		// will be made true if s0 data is received in this session, also means fw >= 1.4
		};
		this.lastResponse = undefined;
	}

	/**
	* Discovers a youless device in the network. Also sets the first discovered ip address for this session.
	* @returns {Promise<discoveredHost[]>} Array with info on discovered routers, including host ip address.
	*/
	async discover() {
		const timeoutBefore = this.timeout;
		const hostBefore = this.host;
		try {
			const servers = dns.getServers() || [];	// get the IP address of all routers in the LAN
			const hostsToTest = [];	// make an array of all host IP's in the LAN
			servers.map((server) => {
				const splitServer = server.split('.').slice(0, 3);
				const reducer = (accumulator, currentValue) => `${accumulator}.${currentValue}`;
				const segment = splitServer.reduce(reducer);
				for (let host = 1; host <= 254; host += 1) {
					const ipToTest = `${segment}.${host}`;
					hostsToTest.push(ipToTest);
				}
				return hostsToTest;
			});
			this.timeout = 3000;	// temporarily set http timeout to 3.5 seconds
			const allHostsPromise = hostsToTest.map(async (hostToTest) => {
				const result = await this.getInfo(hostToTest)
					.catch(() => undefined);
				return result;
			});
			const allHosts = await Promise.all(allHostsPromise);
			const discoveredHosts = allHosts.filter(host => host);
			this.timeout = timeoutBefore;	// reset the timeout
			if (discoveredHosts[0]) {
				this.host = discoveredHosts[0].host;
			} else { throw Error('No device discovered. Please provide host ip manually'); }
			/**
			* @typedef discoveredHost
			* @description discoveredHosts is only available for LS120
			* @property {string} model e.g. 'LS120'
			* @property {string} mac  e.g. '72:b8:ad:14:16:2d'
			* @property {string} host e.g. '192.168.1.10'
			*/
			return Promise.resolve(discoveredHosts);
		} catch (error) {
			this.host = hostBefore;
			this.timeout = timeoutBefore;
			this.lastResponse = error;
			return Promise.reject(error);
		}
	}

	/**
	* Login to the device. Passing parameters will override the previous settings.
	* If host is not set, login will try to auto discover it.
	* @param {string} [password] - The login password.
	* @param {string} [host] - The url or ip address of the device.
	* @param {number} [port] - The  port of the device.
	* @returns {Promise<loggedIn>} The loggedIn state.
	*/
	async login(password, host, port) {
		try {
			this.password = password || this.password;
			this.host = host || await this.host;
			this.port = port || this.port;
			if (!this.host || this.host === '' || !this.port) {
				await this.discover()
					.catch(() => {
						throw Error('Cannot login: host IP and/or port not set');
					});
			}
			if (this.password !== '') {
				await this._makeRequest(loginPath + this.password);
			}
			this.loggedIn = true;
			return Promise.resolve(this.loggedIn);
		} catch (error) {
			this.loggedIn = false;
			return Promise.reject(error);
		}
	}

	/**
	* Get device information without need for credentials. NOTE: Only works for LS120
	* @param {string} [host] - The url or ip address of the device.
	* @returns {Promise<info>}
	*/
	async getInfo(host) {
		const hostBefore = this.host;
		this.host = host || hostBefore;
		try {
			const result = await this._makeRequest(discoverPath);
			const info = JSON.parse(result.body);
			if (!info.model) {
				throw Error('no youless model found');
			}
			info.host = host || hostBefore;
			this.host = hostBefore;
			/**
			* @typedef info
			* @description info is only available for LS120
			* @property {string} model e.g. 'LS120'
			* @property {string} mac  e.g. '72:b8:ad:14:16:2d'
			*/
			return Promise.resolve(info);
		} catch (error) {
			return Promise.reject(error);
		}
	}

	/**
	* Get device information. NOTE: Login is required if a password is set in the device.
	* @param {string} [host] - The url or ip address of the device.
	* @returns {Promise<info2>}
	*/
	async getInfo2(host) {
		const hostBefore = this.host;
		this.host = host || hostBefore;
		try {
			this.loggedIn = true;
			const info2 = { };
			const res = await this._makeRequest(homePath);
			const res2 = await this._makeRequest(networkPath);
			info2.model = res.body.match(regExModelResponse)[1];
			info2.mac = res2.body.match(regExMacResponse)[1];
			info2.firmware = res.body.match(regExFirmwareResponse)[1];
			info2.host = host || hostBefore;
			this.host = hostBefore;
			/**
			* @typedef info2
			* @property {string} model e.g. 'LS120'
			* @property {string} mac  e.g. '72:b8:ad:14:16:2d'
			* @property {string} firmware  e.g. '1.4.1-EL'
			* @property {string} host e.g. '192.168.1.10'
			*/
			return Promise.resolve(info2);
		} catch (error) {
			return Promise.reject(error);
		}
	}

	/**
	* Get basic power information.
	* @returns {Promise<basicStatus>}
	*/
	async getBasicStatus() {
		try {
			const result = await this._makeRequest(basicStatusPath);
			const basicStatus = JSON.parse(result.body);
			if (!Object.prototype.hasOwnProperty.call(basicStatus, 'con')) {
				throw Error('no status information found');
			}
			if (Object.keys(basicStatus).length < 8) {
				throw Error('incomplete status information');
			}
			if (basicStatus.cnt) {
				basicStatus.net = Number(basicStatus.cnt.toString().replace(',', '.'));
			}
			basicStatus.tm = Date.now() / 1000;
			/**
			* @typedef basicStatus
			* @description basicStatus is an object containing power information.
			* @property {string} cnt counter in kWh. e.g. ' 16844,321'
			* @property {number} pwr power consumption in Watt. e.g. 3030
			* @property {number} lvl moving average level (intensity of reflected light on analog meters) e.g. 73
			* @property {string} dev deviation of reflection. e.g. '(&plusmn;0%)'
			* @property {string} det unknown. e.g. ''
			* @property {string} con connection status e.g.'OK'
			* @property {string} sts time until next status update with online monitoring. e.g. '(23)'
			* @property {number} [ps0] computed S0 power. e.g. 0.  NOTE: only for LS120 ^1.4 version firmware
			* @property {number} raw raw 10-bit light reflection level (without averaging). e.g. 732
			* @property {number} net netto counter cnt converted to a number. e.g. 16844.321
			* @property {number} tm time of retrieving info. unix-time-format. e.g. 1542575626.489
			*/
			return Promise.resolve(basicStatus);
		} catch (error) {
			return Promise.reject(error);
		}
	}

	/**
	* Get advanced power information. Only works on Enelogic (-EL) device firmware.
	* @returns {Promise<advancedStatus>}
	*/
	async getAdvancedStatus() {	// only available for LS120
		try {
			const result = await this._makeRequest(advancedStatusPath);
			const advancedStatus = JSON.parse(result.body)[0];
			if (!advancedStatus.tm) {
				throw Error('no status information found');
			}
			const minLength = (3 + (4 * this.info.hasP1Meter) + (this.info.hasGasMeter
				*	(1 + (1 * this.info.hasS0Meter))) + (3 * this.info.hasS0Meter)) || 3;
			if (Object.keys(advancedStatus).length < minLength) {
				this.info.hasP1Meter = undefined;
				this.info.hasGasMeter = undefined;
				this.info.hasS0Meter = undefined;
				throw Error('incomplete status information');
			}
			if (advancedStatus.p1) {	// p1 meter connected
				this.info.hasP1Meter = true;
			} else {	// no p1 meter available
				this.info.hasP1Meter = false;
			}
			if (advancedStatus.gts) {	// gas meter connected, and gas timestamp available
				this.info.hasGasMeter = true;
				advancedStatus.gtm = toEpoch(advancedStatus.gts);
			} else if (advancedStatus.gas) {	// gas meter connected, no gas timestamp avialable (fw<1.4)
				this.info.hasGasMeter = true;
				advancedStatus.gts = 0;
				advancedStatus.gtm = 0;
			} else {	// no gas meter available
				this.info.hasGasMeter = false;
				advancedStatus.gas = 0;
				advancedStatus.gts = 0;
				advancedStatus.gtm = 0;
			}
			if (advancedStatus.ts0) {	// S0 meter available (fw>=v1.4)
				this.info.hasS0Meter = true;
			} else {	// no S0 meter available (fw<1.4)
				this.info.hasS0Meter = false;
				advancedStatus.ts0 = 0;
				advancedStatus.ps0 = 0;
				advancedStatus.cs0 = 0;
			}
			/**
			* @typedef advancedStatus
			* @description advancedStatus is an object containing power information.
			* @property {number} tm time of retrieving info. unix-time-format. e.g. 1542575626
			* @property {number} pwr power consumption in Watt. e.g. 3030
			* @property {number} ts0 time of the last S0 measurement. unix-time-format. e.g. 1542575626 NOTE: only for LS120 ^1.4 version firmware
			* @property {number} [cs0] counter of S0 input (KwH). e.g. 0 NOTE: only for LS120 ^1.4 version firmware
			* @property {number} [ps0] computed S0 power. e.g. 0. NOTE: only for LS120 ^1.4 version firmware
			* @property {number} p1 P1 consumption counter (low tariff). e.g. 16110.964
			* @property {number} p2 P2 consumption counter (high tariff). e.g. 896.812
			* @property {number} n1 N1 production counter (low tariff). e.g. 1570.936
			* @property {number} n2 N2 consumption counter (high tariff). e.g. 4250.32
			* @property {number} gas counter gas-meter (in m^3). e.g. 6161.243
			* @property {number} [gts] time of the last gas measurement (yyMMddhhmm). e.g. 1811182200 NOTE: only for LS120 ^1.4 version firmware
			* @property {number} [gtm] time of the last gas measurement. unix-time-format. e.g. 1542574800 NOTE: only for LS120 ^1.4 version firmware
			*/
			return Promise.resolve(advancedStatus);
		} catch (error) {
			return Promise.reject(error);
		}
	}

	/**
	* Set meter type to D(igital) or A(nalog).
	* @param {string} value - The meter type A(analog) or D(igital).
	* @returns {Promise<finished>}
	*/
	async setMeterType(value) {
		try {
			const validTypes = ['d', 'D', 'a', 'A'];
			if (!(typeof value === 'string') || !(validTypes.indexOf(value[0]) > -1)) {
				throw Error('Meter Type can only be D(igital) or A(nalog)');
			}
			await this._makeRequest(setMeterTypePath + value);
			return Promise.resolve(true);
		} catch (error) {
			return Promise.reject(error);
		}
	}

	/**
	* Set the Power counter value (in KwH) NOTE: also resets powerPulses to 1000
	* @param {number} value - the Power counter value (in KwH)
	* @returns {Promise<finished>}
	*/
	async setPowerCounter(value) {
		try {
			await this._makeRequest(setPowerCounterPath + Number(value));
			return Promise.resolve(true);
		} catch (error) {
			return Promise.reject(error);
		}
	}

	/**
	* Set the Power pulses per KwH value
	* NOTE: also resets powerPulses to 1000
	* NOTE: must be performed AFTER setPowerCounter and setS0Pulses
	* NOTE: will be automatically overwritten by P1 net value
	* @param {number} value - the number of pules per KwH, e.g. 1000
	* @returns {Promise<finished>}
	*/
	async setPowerPulses(value) {
		try {
			const success = await this._makeRequest(setPowerPulsesPath + Number(value));
			return Promise.resolve(success);
		} catch (error) {
			return Promise.reject(error);
		}
	}

	/**
	* Set the S0 counter value.
	* @param {number} value - set the S0 counter value (in KwH)
	* @returns {Promise<finished>}
	*/
	async setS0Counter(value) {
		try {
			await this._makeRequest(setS0CounterPath + (Number(value) * 1000));
			return Promise.resolve(true);
		} catch (error) {
			return Promise.reject(error);
		}
	}

	/**
	* Set the S0 pulses per KwH value NOTE: also resets powerPulses to 1000
	* @param {number} value - the number of pules per KwH, e.g. 1000
	* @returns {Promise<finished>}
	*/
	async setS0Pulses(value) {
		try {
			await this._makeRequest(setS0PulsesPath + Number(value));
			return Promise.resolve(true);
		} catch (error) {
			return Promise.reject(error);
		}
	}

	/**
	* Synchronize the device time with the internet
	* @returns {Promise<dateTime>}
	*/
	async syncTime() {
		try {
			const res = await this._makeRequest(syncTimePath);
			const dateTime = res.body.match(regExTimeResponse)[1];
			return Promise.resolve(dateTime);
		} catch (error) {
			return Promise.reject(error);
		}
	}

	/**
	* Reboot the youless device
	* @returns {Promise<finished>}
	*/
	async reboot() {
		try {
			await this._makeRequest(rebootPath);
			return Promise.resolve(true);
		} catch (error) {
			return Promise.reject(error);
		}
	}

	async _makeRequest(action) {
		try {
			if (!this.loggedIn && !action.includes(loginPath) && !action.includes(discoverPath)) {
				return Promise.reject(Error('Not logged in'));
			}
			const headers = {
				'Content-Length': 0,
				Connection: 'keep-alive',
			};
			if (!action.includes(loginPath) && !action.includes(discoverPath) && this.cookie !== defaultCookie) {
				headers.Cookie = this.cookie;
			}
			const options = {
				hostname: this.host,
				port: this.port,
				path: action,
				headers,
				method: 'GET',
				'User-Agent': 'Youless.js Node Package',
			};
			const res = await this._makeHttpRequest(options, '');
			this.lastResponse = res.body;
			const { statusCode } = res;
			const contentType = res.headers['content-type'];
			if ((statusCode === 302) && options.path.includes(loginPath)) {
				// redirect after login, that's ok
			}	else if (statusCode === 403) {
				// this.loggedIn = false;
				throw Error('Incorrect password');
			}	else if (statusCode === 404) {
				throw Error('Not found. Wrong IP address?');
			}	else if (statusCode !== 200) {
				throw Error(`Request Failed. Status Code: ${statusCode}`);
			} else if
			(!/^application\/json/.test(contentType)
			&& !options.path.includes('/H')
			&& (options.path.includes('?f=j') || options.path.includes('/d') || options.path.includes('/e'))) {
				throw Error(`Invalid content-type. Expected application/json but received ${contentType}`);
			}
			if (res.headers['set-cookie']) {
				this.cookie = res.headers['set-cookie'];
			}
			this.loggedIn = true;
			return Promise.resolve(res);
		}	catch (error) {
			this.loggedIn = false;
			return Promise.reject(error);
		}
	}

	_makeHttpRequest(options, postData) {
		return new Promise((resolve, reject) => {
			const req = http.request(options, (res) => {
				let resBody = '';
				res.on('data', (chunk) => {
					resBody += chunk;
				});
				res.once('end', () => {
					res.body = resBody;
					return resolve(res); // resolve the request
				});
			});
			req.write(postData);
			req.end();
			req.setTimeout(this.timeout, () => {
				req.abort();
				reject(Error('Connection timeout'));
			});
			req.once('error', (e) => {
				this.lastResponse = e;	// e.g. ECONNREFUSED // ECONNRESET on wrong IP
				reject(e);
			});
		});
	}

}

module.exports = Youless;

/*
more detailed information on: http://wiki.td-er.nl/index.php?title=YouLess
*/
