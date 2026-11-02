(function (global) {
  "use strict";

  var SDK_URL = "https://bridge.playgama.com/v2/stable/playgama-bridge.js";
  var sdk = null;
  var initialization = null;
  var initialized = false;
  var readyRequested = false;
  var readySent = false;
  var gameplayActive = false;
  var gameplayReported = false;
  var gameplayEverReported = false;
  var hostPaused = false;
  var hostAudioEnabled = true;
  var enginePaused = false;
  var suspendedAudio = null;
  var activeAd = null;
  var nextRequestId = 1;
  var adRequests = Object.create(null);

  function launchPlatform() {
    var params = new URLSearchParams(global.location.search);
    var explicit = params.get("platform_id");
    if (explicit === "vk" || explicit === "ok") return explicit;
    // Bridge v2 does not auto-detect the legacy OK/FAPI launch parameters.
    if (params.has("api_server") && params.has("apiconnection")) return "ok";
    if (params.has("vk_app_id") ||
        (params.has("api_id") && params.has("viewer_id") && params.has("auth_key"))) return "vk";
    return null;
  }

  function loadSdkScript() {
    if (global.bridge && typeof global.bridge.initialize === "function") return Promise.resolve();
    return new Promise(function (resolve, reject) {
      var script = document.createElement("script");
      var timer = global.setTimeout(function () {
        script.remove();
        reject(new Error("Playgama SDK loading timed out"));
      }, 15000);
      script.src = SDK_URL;
      script.async = true;
      script.onload = function () { global.clearTimeout(timer); resolve(); };
      script.onerror = function () {
        global.clearTimeout(timer);
        reject(new Error("Could not load Playgama SDK"));
      };
      document.head.appendChild(script);
    });
  }

  function sendMessage(message) {
    if (!sdk) return;
    try {
      Promise.resolve(sdk.platform.sendMessage(message)).catch(function (error) {
        console.warn("Playgama lifecycle message failed:", message, error);
      });
    } catch (error) {
      console.warn("Playgama lifecycle message failed:", message, error);
    }
  }

  function isPaused() {
    return document.hidden || hostPaused || activeAd !== null;
  }

  function syncGameplay() {
    var active = gameplayActive && !isPaused();
    if (!sdk || active === gameplayReported) return;
    gameplayReported = active;
    sendMessage(active ? (gameplayEverReported ? "level_resumed" : "level_started") : "level_paused");
    if (active) gameplayEverReported = true;
  }

  function ignoreAudioRejection(promise) {
    if (promise && typeof promise.catch === "function") promise.catch(function () {});
  }

  function syncEngineState() {
    var paused = isPaused();
    var module = global.Module;
    // Wait for Defold to create its main loop before calling Emscripten pause.
    if (module && global.MainLoop && global.MainLoop.func) {
      if (paused && !enginePaused && typeof module.pauseMainLoop === "function") {
        module.pauseMainLoop();
        enginePaused = true;
      } else if (!paused && enginePaused && typeof module.resumeMainLoop === "function") {
        enginePaused = false;
        module.resumeMainLoop();
      }
    }
    var audio = global._dmJSDeviceShared && global._dmJSDeviceShared.audioCtx;
    var muted = paused || !hostAudioEnabled;
    if (audio && muted && audio.state === "running") {
      suspendedAudio = audio;
      ignoreAudioRejection(audio.suspend());
    } else if (audio && !muted && suspendedAudio === audio) {
      suspendedAudio = null;
      ignoreAudioRejection(audio.resume());
    }
    syncGameplay();
  }

  function loadingReady() {
    readyRequested = true;
    if (!sdk || readySent) return false;
    readySent = true;
    sendMessage("game_ready");
    return true;
  }

  function initialize() {
    if (initialization) return initialization;
    var platform = launchPlatform();
    initialization = loadSdkScript().then(function () {
      if (!global.bridge || typeof global.bridge.initialize !== "function") {
        throw new Error("Playgama Bridge is unavailable");
      }
      // The v2 loader reads forciblySetPlatformId from the JSON file, not init options.
      var options = { configFilePath: platform ?
        "./playgama-bridge-config-" + platform + ".json" : "./playgama-bridge-config.json" };
      global.bridge.engine = "defold";
      return new Promise(function (resolve, reject) {
        var timer = global.setTimeout(function () {
          reject(new Error("Platform SDK initialization timed out"));
        }, 20000);
        Promise.resolve(global.bridge.initialize(options)).then(function () {
          global.clearTimeout(timer);
          resolve();
        }, function (error) { global.clearTimeout(timer); reject(error); });
      });
    }).then(function () {
      sdk = global.bridge;
      initialized = true;
      hostPaused = Boolean(sdk.platform.isPaused);
      hostAudioEnabled = sdk.platform.isAudioEnabled !== false;
      sdk.platform.on("pause_state_changed", function (paused) {
        hostPaused = Boolean(paused);
        syncEngineState();
      });
      sdk.platform.on("audio_state_changed", function (enabled) {
        hostAudioEnabled = Boolean(enabled);
        syncEngineState();
      });
      sdk.advertisement.on("interstitial_state_changed", function (state) {
        onAdState("fullscreen", state);
      });
      sdk.advertisement.on("rewarded_state_changed", function (state) {
        onAdState("rewarded", state);
      });
      if (readyRequested) loadingReady();
      syncEngineState();
      return sdk;
    }).catch(function (error) {
      console.error("Playgama SDK initialization failed.", error);
      // A real platform launch must not silently run without its native SDK.
      if (platform) throw error;
      initialized = true;
      return null;
    });
    return initialization;
  }

  function getLanguage() {
    var params = new URLSearchParams(global.location.search);
    var language = (sdk && sdk.platform.language) || params.get("lang") || global.navigator.language;
    language = String(language || "ru").toLowerCase().split(/[-_]/)[0];
    // The game has Russian and English localization; Russian is the fallback.
    return language === "en" ? "en" : "ru";
  }

  function gameplayStart() {
    gameplayActive = true;
    syncGameplay();
  }

  function gameplayStop() {
    gameplayActive = false;
    syncGameplay();
  }

  function finishAd(request, eventName) {
    if (!request || request.closed) return;
    request.closed = true;
    request.events.push(eventName);
    global.clearTimeout(request.timer);
    if (activeAd === request) {
      activeAd = null;
      syncEngineState();
      var canvas = document.getElementById("canvas");
      if (!isPaused() && canvas) canvas.focus();
    }
  }

  function onAdState(kind, state) {
    var request = activeAd;
    if (!request || request.kind !== kind || request.closed) return;
    if (state === "opened") {
      global.clearTimeout(request.timer);
      request.events.push("opened");
    } else if (state === "rewarded" && !request.rewarded) {
      request.rewarded = true;
      request.events.push("rewarded");
    } else if (state === "closed" || state === "failed") {
      finishAd(request, state === "closed" ? "closed" : "error");
    }
  }

  function showAd(kind) {
    var id = String(nextRequestId++);
    var request = { kind: kind, events: [], closed: false, rewarded: false };
    adRequests[id] = request;
    var ads = sdk && sdk.advertisement;
    var supported = ads && (kind === "rewarded" ? ads.isRewardedSupported : ads.isInterstitialSupported);
    // Mock ads on a regular hosting URL must never grant real rewards.
    if (!supported || sdk.platform.id === "mock" || activeAd ||
        ads.interstitialState === "opened" || ads.interstitialState === "loading" ||
        ads.rewardedState === "opened" || ads.rewardedState === "loading") {
      finishAd(request, "error");
      return id;
    }
    activeAd = request;
    syncEngineState();
    // Only bound the loading phase. Never resume the game over an open ad.
    request.timer = global.setTimeout(function () { finishAd(request, "error"); }, 30000);
    try {
      if (kind === "rewarded") ads.showRewarded();
      else ads.showInterstitial();
    } catch (error) {
      console.warn("Playgama ad failed.", error);
      finishAd(request, "error");
    }
    return id;
  }

  function takeAdEvent(id) {
    var request = adRequests[String(id)];
    if (!request || request.events.length === 0) return "";
    var eventName = request.events.shift();
    if (request.closed && request.events.length === 0) delete adRequests[String(id)];
    return eventName;
  }

  function waitForLegacyAd(id, rewarded) {
    return new Promise(function (resolve) {
      var didReward = false;
      function poll() {
        var eventName = takeAdEvent(id);
        if (eventName === "rewarded") didReward = true;
        if (eventName === "closed" || eventName === "error") {
          resolve(rewarded ? didReward : true);
          return;
        }
        global.setTimeout(poll, 50);
      }
      poll();
    });
  }

  var api = Object.freeze({
    initialize: initialize,
    isInitialized: function () { return initialized; },
    isPaused: isPaused,
    getLanguage: getLanguage,
    loadingReady: loadingReady,
    gameplayStart: gameplayStart,
    gameplayStop: gameplayStop,
    showFullscreenAd: function () { return showAd("fullscreen"); },
    showRewardedAd: function () { return showAd("rewarded"); },
    takeAdEvent: takeAdEvent
  });
  global.GamePlatform = api;
  // ABI names baked into the existing Defold assets. These aliases use only Playgama.
  global.YandexGamesBridge = api;
  global.YagsSDK = Object.freeze({
    captureError: function (message) { console.error(String(message || "Game error")); },
    commercialBreak: function (onStart) {
      if (typeof onStart === "function") onStart();
      return waitForLegacyAd(api.showFullscreenAd(), false);
    },
    rewardedBreak: function (options) {
      if (options && typeof options.onStart === "function") options.onStart();
      return waitForLegacyAd(api.showRewardedAd(), true);
    },
    gameplayStart: gameplayStart,
    gameplayStop: gameplayStop,
    getURLParam: function (key) {
      if (key === "lang" || key === "language") return getLanguage();
      return new URLSearchParams(global.location.search).get(String(key)) || "";
    },
    measure: function () {},
    movePill: function () {},
    setDebug: function () {},
    shareableURL: function (parameters) {
      // Never copy platform auth/session parameters into a public share URL.
      var url = new URL(global.location.pathname, global.location.origin);
      Object.keys(parameters || {}).forEach(function (key) {
        if (!/auth|token|secret|session|sign|connection|viewer|api_|vk_/i.test(key)) {
          url.searchParams.set(key, parameters[key]);
        }
      });
      return Promise.resolve(url.toString());
    }
  });

  document.addEventListener("visibilitychange", syncEngineState);
  // Defold creates its audio context after SDK initialization and can resume it on input.
  global.setInterval(syncEngineState, 100);
})(window);
