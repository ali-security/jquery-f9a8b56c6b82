/*
 * Seal fork-CI driver: runs the jQuery QUnit suite (test/index.html) in
 * headless Chrome via puppeteer-core and reports results on stdout.
 *
 * Usage: node test/seal-browser-runner.js <url>
 *   CHROME_PATH       Chrome/Chromium executable (required)
 *   SEAL_TEST_FILTER  optional QUnit `filter` (substring of "module: test")
 *   SEAL_SKIP_TESTS   optional "||"-separated list of exact "module: test" names
 *                     that are not registered (printed as SKIPPED)
 *
 * Exit: 0 all green, 1 failures, 2 timeout / suite never finished.
 */
/* jshint node: true */
"use strict";

var puppeteer = require( "puppeteer-core" );

var OVERALL_TIMEOUT_MS = 40 * 60 * 1000;
var HEARTBEAT_MS = 120 * 1000;
var PREFIX = "__SEAL__";

// Not "url": test/.jshintrc declares the suite's url() helper as a read-only global
var pageUrl = process.argv[ 2 ];
var filter = process.env.SEAL_TEST_FILTER || "";
var skipList = ( process.env.SEAL_SKIP_TESTS || "" ).split( "||" ).map( function( s ) {
	return s.trim();
} ).filter( function( s ) {
	return s.length > 0;
} );

if ( !pageUrl ) {
	console.error( "usage: node test/seal-browser-runner.js <url>" );
	process.exit( 2 );
}
if ( !process.env.CHROME_PATH ) {
	console.error( "CHROME_PATH is not set" );
	process.exit( 2 );
}
if ( filter ) {
	pageUrl += ( pageUrl.indexOf( "?" ) >= 0 ? "&" : "?" ) + "filter=" +
		encodeURIComponent( filter );
}

/*
 * Runs in every frame before any page script. Only the top frame is hooked:
 * fixture iframes reuse parent.QUnit and must not report on their own.
 *
 * QUnit 1.17.1 (external/qunit/qunit.js) assigns window.QUnit as its very
 * last statement, after QUnit.config and the logging-callback registrars
 * exist, so the setter below can configure and hook it synchronously,
 * before test/data/testinit.js or any test/unit/*.js file runs.
 */
function pageHook( skipNames ) {

	// Snapshot natives up front: the ajax "getJSON() - Using Native JSON" test
	// replaces window.JSON with a parse-only stub, and calling JSON.stringify
	// from the reporter while it is installed wedges the whole suite.
	var nativeJSON = window.JSON,
		nativeStringify = nativeJSON.stringify,
		nativeLog = window.console.log,
		nativeConsole = window.console,
		skip = {},
		hooked = false,
		qunitRef, i;

	if ( window.top !== window ) {
		return;
	}

	for ( i = 0; i < skipNames.length; i++ ) {
		skip[ skipNames[ i ] ] = true;
	}

	function emit( type, data ) {
		try {
			nativeLog.call( nativeConsole, "__SEAL__" +
				nativeStringify.call( nativeJSON, { type: type, data: data } ) );
		} catch ( e ) {
			try {
				nativeLog.call( nativeConsole, "__SEAL__" + nativeStringify.call( nativeJSON, {
					type: type, data: { error: "unserializable payload: " + e }
				} ) );
			} catch ( e2 ) {}
		}
	}

	function dump( value ) {
		var out,
			dumper = qunitRef && ( qunitRef.dump || qunitRef.jsDump );
		try {
			out = dumper ? dumper.parse( value ) : String( value );
		} catch ( e ) {
			try {
				out = String( value );
			} catch ( e2 ) {
				out = "<undumpable>";
			}
		}
		if ( typeof out === "string" && out.length > 2000 ) {
			out = out.slice( 0, 2000 ) + "...";
		}
		return out;
	}

	function hookQUnit( q ) {
		var origTest, wrappedTest;

		if ( hooked || !q || !q.config || typeof q.test !== "function" ) {
			return;
		}
		hooked = true;

		q.config.reorder = false;

		// Collapse passed tests in the HTML report (QUnit's own "Hide passed tests"
		// option; display-only). Without it the 800+ row report keeps the page tall,
		// so the offset module's setup scroll ( window.scrollTo( 1, 1 ) ) no longer
		// clamps back to 0 and offsets of hidden elements read pageYOffset = 1.
		q.config.hidepassed = true;

		// Skip support: test/unit/*.js declare tests with QUnit.test and
		// QUnit.asyncTest; QUnit.asyncTest and the testinit.js helpers
		// (ajaxTest, testIframe, testIframeWithCallback) all call QUnit.test,
		// where QUnit.config.currentModule.name is the effective module.
		origTest = q.test;
		wrappedTest = function( testName ) {
			var mod = q.config.currentModule,
				modName = mod && typeof mod === "object" ? mod.name : mod,
				key = ( modName ? modName + ": " : "" ) + testName;
			if ( skip[ key ] ) {
				emit( "skip", { name: key } );
				return;
			}
			return origTest.apply( this, arguments );
		};
		q.test = wrappedTest;

		// qunit.js copied QUnit.test onto window before exporting window.QUnit
		window.test = wrappedTest;

		q.begin( function() {
			emit( "begin", {} );
		} );
		q.moduleStart( function( d ) {
			emit( "moduleStart", { name: d.name } );
		} );
		q.testStart( function( d ) {
			emit( "testStart", { name: d.name, module: d.module } );
		} );
		q.log( function( d ) {
			if ( d.result ) {
				return;
			}
			emit( "log", {
				module: d.module,
				name: d.name,
				message: d.message === undefined ? "" : String( d.message ),
				actual: dump( d.actual ),
				expected: dump( d.expected ),
				source: d.source === undefined ? "" : String( d.source )
			} );
		} );
		q.testDone( function( d ) {
			emit( "testDone", {
				name: d.name,
				module: d.module,
				failed: d.failed,
				passed: d.passed,
				total: d.total
			} );
		} );
		q.done( function( d ) {
			emit( "done", {
				failed: d.failed,
				passed: d.passed,
				total: d.total,
				runtime: d.runtime
			} );
		} );
	}

	Object.defineProperty( window, "QUnit", {
		configurable: true,
		enumerable: true,
		get: function() {
			return qunitRef;
		},
		set: function( v ) {
			qunitRef = v;
			hookQUnit( v );
		}
	} );
}

function pad( s, n ) {
	s = String( s );
	while ( s.length < n ) {
		s += " ";
	}
	return s;
}

function main() {
	var browser, page,
		finished = false,
		done = null,
		modules = {},
		moduleOrder = [],
		failedTests = 0,
		passedTests = 0,
		skippedTests = [],
		currentTest = null,
		lastProgress = Date.now(),
		lastHeartbeat = Date.now(),
		heartbeatTimer, overallTimer;

	function moduleStats( name ) {
		if ( !modules[ name ] ) {
			modules[ name ] = { tests: 0, failedTests: 0, assertions: 0, failedAssertions: 0 };
			moduleOrder.push( name );
		}
		return modules[ name ];
	}

	function printSummary() {
		var totalTests = passedTests + failedTests;
		console.log( "" );
		console.log( "==================== SUMMARY ====================" );
		if ( skippedTests.length ) {
			console.log( "Skipped (not registered): " + skippedTests.length );
			skippedTests.forEach( function( n ) {
				console.log( "  SKIPPED: " + n );
			} );
		}
		console.log( pad( "module", 28 ) + pad( "tests", 8 ) + pad( "failed", 8 ) +
			pad( "assertions", 12 ) + "failed" );
		moduleOrder.forEach( function( name ) {
			var m = modules[ name ];
			console.log( pad( name, 28 ) + pad( m.tests, 8 ) + pad( m.failedTests, 8 ) +
				pad( m.assertions, 12 ) + m.failedAssertions );
		} );
		if ( done ) {
			console.log( "Tests: " + passedTests + " passed, " + failedTests + " failed, " +
				totalTests + " total; Assertions: " + done.passed + " passed, " + done.failed +
				" failed, " + done.total + " total; runtime " + done.runtime + " ms" );
		} else {
			console.log( "Tests: " + passedTests + " passed, " + failedTests + " failed, " +
				totalTests + " total; QUnit done NEVER fired" );
		}
	}

	function finish( code, reason ) {
		var closing;
		if ( finished ) {
			return;
		}
		finished = true;
		clearInterval( heartbeatTimer );
		clearTimeout( overallTimer );
		if ( reason ) {
			console.log( reason );
		}
		printSummary();
		closing = browser ? browser.close() : Promise.resolve();
		closing[ "catch" ]( function() {} ).then( function() {
			process.exit( code );
		} );

		// Do not let a hung browser.close() keep us alive.
		setTimeout( function() {
			process.exit( code );
		}, 15000 ).unref();
	}

	function onEvent( ev ) {
		var d = ev.data || {},
			m;
		switch ( ev.type ) {
		case "begin":
			console.log( "QUnit begin" );
			break;
		case "moduleStart":
			console.log( "MODULE " + d.name );
			break;
		case "testStart":
			currentTest = ( d.module ? d.module + ": " : "" ) + d.name;
			break;
		case "log":
			console.log( "    assertion failed: " + d.message );
			console.log( "      expected: " + d.expected );
			console.log( "      actual:   " + d.actual );
			if ( d.source ) {
				console.log( "      source:   " +
					String( d.source ).split( "\n" ).join( "\n                " ) );
			}
			break;
		case "testDone":
			lastProgress = Date.now();
			lastHeartbeat = lastProgress;
			currentTest = null;
			m = moduleStats( d.module || "(no module)" );
			m.tests++;
			m.assertions += d.total;
			m.failedAssertions += d.failed;
			if ( d.failed > 0 ) {
				m.failedTests++;
				failedTests++;
			} else {
				passedTests++;
			}
			console.log( ( d.failed > 0 ? "FAIL" : "PASS" ) + " [" + d.module + "] " + d.name +
				" (" + d.passed + "/" + d.total + ")" );
			break;
		case "skip":
			skippedTests.push( d.name );
			console.log( "SKIPPED: " + d.name );
			break;
		case "done":
			done = d;
			finish( d.failed === 0 && failedTests === 0 ? 0 : 1 );
			break;
		default:
			console.log( "unknown event: " + JSON.stringify( ev ) );
		}
	}

	overallTimer = setTimeout( function() {
		finish( 2, "TIMEOUT: suite did not finish within " + ( OVERALL_TIMEOUT_MS / 60000 ) +
			" minutes" + ( currentTest ? " (running: " + currentTest + ")" : "" ) );
	}, OVERALL_TIMEOUT_MS );

	heartbeatTimer = setInterval( function() {
		var now = Date.now();
		if ( now - lastHeartbeat >= HEARTBEAT_MS ) {
			lastHeartbeat = now;
			console.log( "HEARTBEAT: no test completed in " +
				Math.round( ( now - lastProgress ) / 1000 ) + "s; running: " +
				( currentTest || "(none / between tests)" ) );
		}
	}, 5000 );

	console.log( "URL: " + pageUrl );
	if ( skipList.length ) {
		console.log( "SEAL_SKIP_TESTS: " + skipList.length + " test(s)" );
	}

	puppeteer.launch( {
		executablePath: process.env.CHROME_PATH,
		headless: true,
		args: [ "--no-sandbox", "--headless=new", "--disable-gpu", "--force-device-scale-factor=1" ]
	} ).then( function( b ) {
		browser = b;
		browser.on( "disconnected", function() {
			finish( 2, "ERROR: browser disconnected before QUnit done" );
		} );
		return browser.newPage();
	} ).then( function( p ) {
		page = p;
		page.on( "console", function( msg ) {
			var text = msg.text(),
				ev;
			if ( text.indexOf( PREFIX ) !== 0 ) {
				return;
			}
			try {
				ev = JSON.parse( text.slice( PREFIX.length ) );
			} catch ( e ) {
				console.log( "unparseable reporter line: " + text.slice( 0, 500 ) );
				return;
			}
			onEvent( ev );
		} );
		page.on( "pageerror", function( err ) {
			console.log( "PAGE ERROR: " + ( err && err.message ? err.message : String( err ) ) );
		} );
		page.on( "dialog", function( dialog ) {
			console.log( "DIALOG (" + dialog.type() + "): " + dialog.message() );
			dialog.dismiss()[ "catch" ]( function() {} );
		} );
		page.on( "error", function( err ) {
			finish( 2, "ERROR: page crashed: " + ( err && err.message ? err.message : String( err ) ) );
		} );
		return page.evaluateOnNewDocument( pageHook, skipList );
	} ).then( function() {

		// "goto" is an ES3 reserved word (test/.jshintrc sets es3)
		return page[ "goto" ]( pageUrl, { waitUntil: "load", timeout: 120000 } );
	} ).then( function() {
		console.log( "page loaded; waiting for QUnit done" );
	} )[ "catch" ]( function( err ) {
		finish( 2, "ERROR: " + ( err && err.stack ? err.stack : String( err ) ) );
	} );
}

main();
