## Nodejs package to communicate with Youless energy monitors LS110 and LS120.

### It allows you to:

#### get:
* device information, including firmware version
* live energy readings of analogue and digital meters
* live energy and gas readings of P1 smart meters (LS120 only)
* live readings of the S0 input (LS120 only)
* live readings of the optical sensor


#### set:
* meter type to Digital or Analogue
* power pulses per KwH value
* power counter value
* S0 pulses per KwH value
* S0 counter value


#### do:
* discover the device in a local network
* login with or without password
* synchronize the device time with the internet
* reboot the device


### Note:
This package has been developed and tested with the Enelogic (-EL) firmware.
Other firmware versions (-PO, -PO2 and -EO) might not be fully supported,
especially for the function getAdvancedStatus().

### Install:
If you don't have Node installed yet, get it from: [Nodejs.org](https://nodejs.org "Nodejs website").

To install the netgear package:
```
> npm i youless
```

### Test:
From the folder in which you installed the netgear package, just run this command.
```
> npm test myPassword
```
If you have no password set in the device, you can leave out 'myPassword'.


### Quickstart:

```
// create a youless session, login to device (will also discover the ip address), fetch basic power info
	const Youless = require('youless');

	const youless = new Youless();

	async function getPower() {
		try {
			await youless.login('myPassword');	// leave password empty if not set
			const powerInfo = await youless.getBasicInfo();
			console.log(powerInfo);
		} catch (error) {
			console.log(error);
		}
	}

	getPower();
```

## Detailed documentation:
[Detailed documentation](https://gruijter.github.io/youless.js/ "Youless.js documentation")

