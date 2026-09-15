/*
 * background/google.js — Google Calendar OAuth 2.0 (PKCE) + event insertion.
 *
 * Why PKCE + launchWebAuthFlow instead of chrome.identity.getAuthToken?
 *   - getAuthToken is Chrome-only and requires a published/keyed extension.
 *   - launchWebAuthFlow exists on both Chrome and Firefox, so one code path
 *     serves both stores.
 *
 * The redirect URI is whatever browser.identity.getRedirectURL() returns
 * (https://<id>.chromiumapp.org/ on Chrome, https://<hash>.extensions.allizom.org/
 * on Firefox) and MUST be added to the OAuth client's authorised redirect URIs.
 * The options page shows the exact value to paste into Google Cloud Console.
 */
(function () {
  "use strict";
  var g = globalThis;
  g.SkoolCal = g.SkoolCal || {};
  var CONST = g.SkoolCal.CONST;
  var storage = g.SkoolCal.storage;
  var browser = g.SkoolCal.browser;
  var dt = g.SkoolCal.dt;

  /* ---- PKCE helpers ---------------------------------------------------- */

  function randomVerifier() {
    var bytes = new Uint8Array(32);
    (g.crypto || g.msCrypto).getRandomValues(bytes);
    return base64Url(bytes);
  }

  function base64Url(bytes) {
    var str = "";
    for (var i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
    return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function sha256Base64Url(input) {
    var data = new TextEncoder().encode(input);
    return g.crypto.subtle.digest("SHA-256", data).then(function (digest) {
      return base64Url(new Uint8Array(digest));
    });
  }

  function formEncode(obj) {
    return Object.keys(obj).map(function (k) {
      return encodeURIComponent(k) + "=" + encodeURIComponent(obj[k]);
    }).join("&");
  }

  function parseQuery(url) {
    var out = {};
    var qIndex = url.indexOf("?");
    if (qIndex === -1) return out;
    var query = url.slice(qIndex + 1).split("#")[0];
    query.split("&").forEach(function (pair) {
      if (!pair) return;
      var eq = pair.indexOf("=");
      var k = decodeURIComponent(pair.slice(0, eq));
      out[k] = decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, " "));
    });
    return out;
  }

  /* ---- OAuth flow ------------------------------------------------------ */

  function getRedirectUri() {
    return browser.identity.getRedirectURL();
  }

  function connect() {
    return storage.getSettings().then(function (settings) {
      var clientId = (settings.googleClientId || "").trim();
      if (!clientId) {
        throw new Error("Add your Google OAuth Client ID in Settings first (see README: Google Cloud setup).");
      }
      var verifier = randomVerifier();
      var redirectUri = getRedirectUri();

      return sha256Base64Url(verifier).then(function (challenge) {
        var authUrl = CONST.GOOGLE.AUTH_ENDPOINT + "?" + formEncode({
          client_id: clientId,
          redirect_uri: redirectUri,
          response_type: "code",
          scope: CONST.GOOGLE.SCOPES,
          code_challenge: challenge,
          code_challenge_method: "S256",
          access_type: "offline",
          prompt: "consent",
          include_granted_scopes: "true"
        });

        return browser.identity.launchWebAuthFlow({ url: authUrl, interactive: true });
      }).then(function (redirectedTo) {
        if (!redirectedTo) throw new Error("Google sign-in was cancelled.");
        var params = parseQuery(redirectedTo);
        if (params.error) throw new Error("Google returned: " + params.error);
        if (!params.code) throw new Error("No authorization code returned. Check the redirect URI is whitelisted.");
        return exchangeCode(params.code, verifier, redirectUri, clientId);
      }).then(function (token) {
        return fetchEmail(token.access_token).then(function (email) {
          var auth = {
            access_token: token.access_token,
            refresh_token: token.refresh_token || null,
            expires_at: Date.now() + (token.expires_in ? token.expires_in * 1000 : 3600000) - 60000,
            scope: token.scope || CONST.GOOGLE.SCOPES,
            email: email || null,
            connectedAt: new Date().toISOString()
          };
          return storage.setAuth(auth).then(function () { return authStatus(); });
        });
      });
    });
  }

  function exchangeCode(code, verifier, redirectUri, clientId) {
    return fetch(CONST.GOOGLE.TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formEncode({
        client_id: clientId,
        code: code,
        code_verifier: verifier,
        grant_type: "authorization_code",
        redirect_uri: redirectUri
      })
    }).then(function (res) {
      return res.json().then(function (body) {
        if (!res.ok) throw new Error("Token exchange failed: " + (body.error_description || body.error || res.status));
        return body;
      });
    });
  }

  function refreshToken(auth) {
    return storage.getSettings().then(function (settings) {
      var clientId = (settings.googleClientId || "").trim();
      if (!clientId) throw new Error("Missing Google OAuth Client ID.");
      if (!auth || !auth.refresh_token) throw new Error("Session expired — please reconnect Google Calendar.");
      return fetch(CONST.GOOGLE.TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: formEncode({
          client_id: clientId,
          refresh_token: auth.refresh_token,
          grant_type: "refresh_token"
        })
      }).then(function (res) {
        return res.json().then(function (body) {
          if (!res.ok) throw new Error("Token refresh failed: " + (body.error_description || body.error || res.status));
          var next = Object.assign({}, auth, {
            access_token: body.access_token,
            expires_at: Date.now() + (body.expires_in ? body.expires_in * 1000 : 3600000) - 60000
          });
          return storage.setAuth(next).then(function () { return next.access_token; });
        });
      });
    });
  }

  function fetchEmail(accessToken) {
    return fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: "Bearer " + accessToken }
    }).then(function (res) {
      if (!res.ok) return null;
      return res.json().then(function (b) { return b.email || null; }).catch(function () { return null; });
    }).catch(function () { return null; });
  }

  /** Returns a valid access token, refreshing if needed. */
  function getAccessToken() {
    return storage.getAuth().then(function (auth) {
      if (!auth) throw new Error("Not connected to Google Calendar.");
      if (auth.access_token && auth.expires_at && Date.now() < auth.expires_at) return auth.access_token;
      return refreshToken(auth);
    });
  }

  function authStatus() {
    return storage.getAuth().then(function (auth) {
      return {
        connected: !!(auth && (auth.access_token || auth.refresh_token)),
        email: auth ? auth.email : null,
        expiresAt: auth ? auth.expires_at : null,
        redirectUri: getRedirectUri(),
        clientIdConfigured: false
      };
    }).then(function (status) {
      return storage.getSettings().then(function (settings) {
        status.clientIdConfigured = !!(settings.googleClientId || "").trim();
        return status;
      });
    });
  }

  function signOut() {
    return storage.getAuth().then(function (auth) {
      var token = auth && (auth.access_token || auth.refresh_token);
      var done = token
        ? fetch("https://oauth2.googleapis.com/revoke", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: "token=" + encodeURIComponent(token)
          }).catch(function () { /* revoke is best-effort */ })
        : Promise.resolve();
      return done.then(function () { return storage.clearAuth(); });
    });
  }

  /* ---- Calendar API ---------------------------------------------------- */

  /**
   * Insert a single event.
   * A 409 means Google already has an event with this iCalUID — we treat that
   * as success so re-running a sync is idempotent.
   */
  function insertEvent(accessToken, calendarId, event, options) {
    var body = g.SkoolCal.events.toGoogleEvent(event, options);
    var url = CONST.GOOGLE.CALENDAR_API + "/calendars/" + encodeURIComponent(calendarId) + "/events";

    return fetch(url, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + accessToken,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (payload) {
        if (res.status === 409) return { status: "duplicate", id: (payload.error && payload.error.errors && payload.error.errors[0] && payload.error.errors[0].reason) || "duplicate" };
        if (res.status === 401 || res.status === 403) {
          var reason = payload.error && payload.error.errors && payload.error.errors[0] && payload.error.errors[0].reason;
          if (reason === "rateLimitExceeded" || reason === "userRateLimitExceeded") {
            return { status: "retry", error: "Rate limited by Google. Try again in a minute." };
          }
          throw new Error((payload.error && payload.error.message) || "Google rejected the request (" + res.status + ").");
        }
        if (!res.ok) throw new Error((payload.error && payload.error.message) || ("Insert failed (" + res.status + ")."));
        return { status: "inserted", id: payload.id, htmlLink: payload.htmlLink };
      });
    });
  }

  /**
   * Sync a batch of events sequentially (Google quotas are per-user, and
   * sequential requests keep us well under the 10 req/sec limit).
   * onProgress(done, total, currentResult) is called after each event.
   */
  function syncEvents(events, options, onProgress) {
    var opts = options || {};
    var calendarId = opts.calendarId || "primary";
    var results = { inserted: 0, duplicate: 0, failed: 0, errors: [], total: events.length };

    return getAccessToken().then(function (token) {
      var chain = Promise.resolve();
      events.forEach(function (ev, index) {
        chain = chain.then(function () {
          return insertEvent(token, calendarId, ev, opts).then(function (r) {
            if (r.status === "inserted") results.inserted++;
            else if (r.status === "duplicate") results.duplicate++;
            else if (r.status === "retry") { results.failed++; results.errors.push(ev.title + ": " + r.error); }
            if (onProgress) onProgress(index + 1, events.length, ev, r);
          }).catch(function (err) {
            results.failed++;
            results.errors.push((ev.title || "Untitled") + ": " + ((err && err.message) || err));
            if (onProgress) onProgress(index + 1, events.length, ev, { status: "error", error: (err && err.message) || String(err) });
          });
        });
        // Space requests slightly to stay polite with the API.
        chain = chain.then(function () { return new Promise(function (r) { setTimeout(r, 120); }); });
      });
      return chain.then(function () { return results; });
    });
  }

  g.SkoolCal.google = {
    getRedirectUri: getRedirectUri,
    connect: connect,
    getAccessToken: getAccessToken,
    authStatus: authStatus,
    signOut: signOut,
    insertEvent: insertEvent,
    syncEvents: syncEvents
  };
})();
