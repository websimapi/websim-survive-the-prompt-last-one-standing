import { jsxDEV } from "react/jsx-dev-runtime";
import React, { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { WebsimSocket, useQuery } from "@websim/use-query";
const room = new WebsimSocket();
const SEASON_END = /* @__PURE__ */ new Date("2025-08-31T23:59:59");
const CREDITS_PER_HOUR = 10;
const MINUTES_PER_PROMPT = 10;
function SurvivalGame() {
  const [currentUser, setCurrentUser] = useState(null);
  const [gameState, setGameState] = useState("loading");
  const [timeLeft, setTimeLeft] = useState(0);
  const [tipAmount, setTipAmount] = useState(10);
  const { data: players, loading: playersLoading } = useQuery(room.collection("players"));
  const { data: myPlayer, loading: myPlayerLoading } = useQuery(
    currentUser ? room.collection("players").filter({ id: currentUser.id }) : null
  );
  const { data: leaderboardData, loading: leaderboardLoading } = useQuery(room.collection("leaderboard_cache"));
  useEffect(() => {
    async function initUser() {
      const user = await window.websim.getCurrentUser();
      setCurrentUser(user);
    }
    initUser();
  }, []);
  useEffect(() => {
    if (/* @__PURE__ */ new Date() > SEASON_END) {
      setGameState("season_ended");
      return;
    }
    if (myPlayer && myPlayer.length > 0) {
      const player = myPlayer[0];
      if (player.dead) {
        setGameState("dead");
      } else {
        setGameState("playing");
        updateSurvivalTime(player);
      }
    } else if (currentUser && !myPlayerLoading) {
      setGameState("not_joined");
    }
  }, [myPlayer, currentUser, myPlayerLoading]);
  const updateSurvivalTime = async (player) => {
    const now = /* @__PURE__ */ new Date();
    const lastCheck = new Date(player.last_check);
    const timeSinceCheck = now - lastCheck;
    const hoursElapsed = timeSinceCheck / (1e3 * 60 * 60);
    const remainingHours = player.survival_hours - hoursElapsed;
    if (remainingHours <= 0) {
      await checkAndUpdateActivity(player.id);
      return;
    }
    setTimeLeft(remainingHours * 3600);
  };
  const checkAndUpdateActivity = async (playerId) => {
    try {
      const user = await window.websim.getCurrentUser();
      const activityData = await fetchUserActivity(user.id);
      const player = myPlayer[0];
      const lastCheck = new Date(player.last_check);
      const newPrompts = countPromptsSince(activityData, lastCheck);
      const bonusMinutes = newPrompts * MINUTES_PER_PROMPT;
      const bonusHours = bonusMinutes / 60;
      const now = /* @__PURE__ */ new Date();
      const timeSinceCheck = (now - lastCheck) / (1e3 * 60 * 60);
      const updatedSurvivalHours = Math.max(0, player.survival_hours - timeSinceCheck + bonusHours);
      if (updatedSurvivalHours <= 0) {
        await room.collection("players").upsert({
          id: playerId,
          dead: true,
          death_time: now.toISOString(),
          last_check: now.toISOString()
        });
        setGameState("dead");
      } else {
        await room.collection("players").upsert({
          id: playerId,
          survival_hours: updatedSurvivalHours,
          total_prompts: player.total_prompts + newPrompts,
          last_check: now.toISOString(),
          cached_activity_timestamp: now.toISOString()
          // For smart caching
        });
        setTimeLeft(updatedSurvivalHours * 3600);
      }
      updateLeaderboardCache();
    } catch (error) {
      console.error("Error checking activity:", error);
    }
  };
  const fetchUserActivity = async (userId) => {
    return {
      prompts: Math.floor(Math.random() * 5),
      lastActivity: /* @__PURE__ */ new Date()
    };
  };
  const countPromptsSince = (activityData, sinceDate) => {
    return activityData.prompts || 0;
  };
  const joinGame = async () => {
    if (!currentUser) return;
    const now = /* @__PURE__ */ new Date();
    await room.collection("players").upsert({
      id: currentUser.id,
      username: currentUser.username,
      survival_hours: 24,
      // Starting time
      total_tips: 0,
      total_prompts: 0,
      join_time: now.toISOString(),
      last_check: now.toISOString(),
      dead: false,
      cached_activity_timestamp: now.toISOString()
    });
    setGameState("playing");
    setTimeLeft(24 * 3600);
    updateLeaderboardCache();
  };
  const tipToSurvive = async () => {
    if (!currentUser || gameState !== "playing") return;
    try {
      await window.websim.postComment({
        content: `Tipping ${tipAmount} credits to survive! \u{1F4B0}\u23F0`,
        credits: tipAmount
      });
      const hoursToAdd = tipAmount / CREDITS_PER_HOUR;
      const player = myPlayer[0];
      await room.collection("players").upsert({
        id: currentUser.id,
        survival_hours: player.survival_hours + hoursToAdd,
        total_tips: player.total_tips + tipAmount,
        last_check: (/* @__PURE__ */ new Date()).toISOString()
      });
      await room.collection("tips").upsert({
        player_id: currentUser.id,
        amount: tipAmount,
        timestamp: (/* @__PURE__ */ new Date()).toISOString()
      });
      updateLeaderboardCache();
    } catch (error) {
      console.error("Tip failed:", error);
    }
  };
  const updateLeaderboardCache = async () => {
    if (!players) return;
    const alivePlayers = players.filter((p) => !p.dead);
    const topTippers = [...alivePlayers].sort((a, b) => b.total_tips - a.total_tips).slice(0, 10);
    const topPrompters = [...alivePlayers].sort((a, b) => b.total_prompts - a.total_prompts).slice(0, 10);
    await room.collection("leaderboard_cache").upsert({
      id: "current",
      top_tippers: topTippers,
      top_prompters: topPrompters,
      total_alive: alivePlayers.length,
      last_updated: (/* @__PURE__ */ new Date()).toISOString()
    });
  };
  const checkActivity = async () => {
    if (myPlayer && myPlayer.length > 0) {
      await checkAndUpdateActivity(myPlayer[0].id);
    }
  };
  useEffect(() => {
    if (gameState === "playing" && timeLeft > 0) {
      const timer = setInterval(() => {
        setTimeLeft((prev) => {
          if (prev <= 1) {
            checkActivity();
            return 0;
          }
          return prev - 1;
        });
      }, 1e3);
      return () => clearInterval(timer);
    }
  }, [gameState, timeLeft]);
  const formatTime = (seconds) => {
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor(seconds % 3600 / 60);
    const secs = Math.floor(seconds % 60);
    return `${hours}h ${mins}m ${secs}s`;
  };
  const getDaysUntilSeasonEnd = () => {
    const now = /* @__PURE__ */ new Date();
    const diff = SEASON_END - now;
    return Math.ceil(diff / (1e3 * 60 * 60 * 24));
  };
  if (gameState === "loading") {
    return /* @__PURE__ */ jsxDEV("div", { className: "min-h-screen bg-gradient-to-br from-purple-900 via-blue-900 to-indigo-900 flex items-center justify-center", children: /* @__PURE__ */ jsxDEV("div", { className: "text-white text-2xl animate-pulse", children: "Loading..." }, void 0, false, {
      fileName: "<stdin>",
      lineNumber: 239,
      columnNumber: 17
    }, this) }, void 0, false, {
      fileName: "<stdin>",
      lineNumber: 238,
      columnNumber: 13
    }, this);
  }
  if (gameState === "season_ended") {
    return /* @__PURE__ */ jsxDEV("div", { className: "min-h-screen bg-gradient-to-br from-red-900 via-gray-900 to-black flex items-center justify-center text-center", children: /* @__PURE__ */ jsxDEV("div", { className: "bg-black/50 backdrop-blur-lg rounded-2xl p-8 max-w-md", children: [
      /* @__PURE__ */ jsxDEV("h1", { className: "text-4xl font-bold text-red-400 mb-4", children: "Season Ended" }, void 0, false, {
        fileName: "<stdin>",
        lineNumber: 248,
        columnNumber: 21
      }, this),
      /* @__PURE__ */ jsxDEV("p", { className: "text-gray-300", children: "The survival season has concluded. Thank you for playing!" }, void 0, false, {
        fileName: "<stdin>",
        lineNumber: 249,
        columnNumber: 21
      }, this)
    ] }, void 0, true, {
      fileName: "<stdin>",
      lineNumber: 247,
      columnNumber: 17
    }, this) }, void 0, false, {
      fileName: "<stdin>",
      lineNumber: 246,
      columnNumber: 13
    }, this);
  }
  return /* @__PURE__ */ jsxDEV("div", { className: "min-h-screen bg-gradient-to-br from-purple-900 via-blue-900 to-indigo-900", children: /* @__PURE__ */ jsxDEV("div", { className: "container mx-auto px-4 py-8", children: [
    /* @__PURE__ */ jsxDEV("header", { className: "text-center mb-8", children: [
      /* @__PURE__ */ jsxDEV("h1", { className: "text-5xl font-bold text-white mb-2 glow-text", children: "Survive the Prompt" }, void 0, false, {
        fileName: "<stdin>",
        lineNumber: 259,
        columnNumber: 21
      }, this),
      /* @__PURE__ */ jsxDEV("p", { className: "text-xl text-gray-300 mb-4", children: "Last One Standing Wins" }, void 0, false, {
        fileName: "<stdin>",
        lineNumber: 262,
        columnNumber: 21
      }, this),
      /* @__PURE__ */ jsxDEV("div", { className: "text-lg text-yellow-400", children: [
        "Season ends in ",
        getDaysUntilSeasonEnd(),
        " days"
      ] }, void 0, true, {
        fileName: "<stdin>",
        lineNumber: 263,
        columnNumber: 21
      }, this)
    ] }, void 0, true, {
      fileName: "<stdin>",
      lineNumber: 258,
      columnNumber: 17
    }, this),
    gameState === "not_joined" && /* @__PURE__ */ jsxDEV("div", { className: "max-w-2xl mx-auto", children: /* @__PURE__ */ jsxDEV("div", { className: "bg-black/30 backdrop-blur-lg rounded-3xl p-8 text-center border border-purple-500/30", children: [
      /* @__PURE__ */ jsxDEV("h2", { className: "text-3xl font-bold text-white mb-6", children: "Enter the Arena" }, void 0, false, {
        fileName: "<stdin>",
        lineNumber: 271,
        columnNumber: 29
      }, this),
      /* @__PURE__ */ jsxDEV("div", { className: "space-y-4 text-gray-300 mb-8", children: [
        /* @__PURE__ */ jsxDEV("p", { children: "\u{1F3AF} Start with 24 hours to survive" }, void 0, false, {
          fileName: "<stdin>",
          lineNumber: 273,
          columnNumber: 33
        }, this),
        /* @__PURE__ */ jsxDEV("p", { children: "\u{1F4B0} +1 hour for every 10 credits tipped" }, void 0, false, {
          fileName: "<stdin>",
          lineNumber: 274,
          columnNumber: 33
        }, this),
        /* @__PURE__ */ jsxDEV("p", { children: "\u26A1 +10 minutes for every prompt since last check" }, void 0, false, {
          fileName: "<stdin>",
          lineNumber: 275,
          columnNumber: 33
        }, this),
        /* @__PURE__ */ jsxDEV("p", { children: "\u{1F480} Reach 0 hours without activity = Game Over" }, void 0, false, {
          fileName: "<stdin>",
          lineNumber: 276,
          columnNumber: 33
        }, this)
      ] }, void 0, true, {
        fileName: "<stdin>",
        lineNumber: 272,
        columnNumber: 29
      }, this),
      /* @__PURE__ */ jsxDEV(
        "button",
        {
          onClick: joinGame,
          className: "survival-button bg-gradient-to-r from-green-500 to-emerald-600 hover:from-green-600 hover:to-emerald-700 text-white px-8 py-4 rounded-full text-xl font-bold transition-all duration-300 transform hover:scale-105",
          children: "Join the Survival Game"
        },
        void 0,
        false,
        {
          fileName: "<stdin>",
          lineNumber: 278,
          columnNumber: 29
        },
        this
      )
    ] }, void 0, true, {
      fileName: "<stdin>",
      lineNumber: 270,
      columnNumber: 25
    }, this) }, void 0, false, {
      fileName: "<stdin>",
      lineNumber: 269,
      columnNumber: 21
    }, this),
    gameState === "playing" && /* @__PURE__ */ jsxDEV("div", { className: "grid lg:grid-cols-3 gap-8", children: [
      /* @__PURE__ */ jsxDEV("div", { className: "lg:col-span-2", children: [
        /* @__PURE__ */ jsxDEV("div", { className: "bg-black/30 backdrop-blur-lg rounded-3xl p-8 border border-purple-500/30 mb-6", children: [
          /* @__PURE__ */ jsxDEV("h2", { className: "text-2xl font-bold text-white mb-4", children: "Your Survival Status" }, void 0, false, {
            fileName: "<stdin>",
            lineNumber: 293,
            columnNumber: 33
          }, this),
          /* @__PURE__ */ jsxDEV("div", { className: "text-center", children: [
            /* @__PURE__ */ jsxDEV("div", { className: `text-6xl font-bold mb-4 ${timeLeft < 3600 ? "text-red-400 animate-pulse" : timeLeft < 7200 ? "text-yellow-400" : "text-green-400"}`, children: formatTime(timeLeft) }, void 0, false, {
              fileName: "<stdin>",
              lineNumber: 295,
              columnNumber: 37
            }, this),
            /* @__PURE__ */ jsxDEV("div", { className: "w-full bg-gray-700 rounded-full h-4 mb-6", children: /* @__PURE__ */ jsxDEV(
              "div",
              {
                className: `h-4 rounded-full transition-all duration-1000 ${timeLeft < 3600 ? "bg-red-500" : timeLeft < 7200 ? "bg-yellow-500" : "bg-green-500"}`,
                style: { width: `${Math.min(100, timeLeft / (24 * 3600) * 100)}%` }
              },
              void 0,
              false,
              {
                fileName: "<stdin>",
                lineNumber: 299,
                columnNumber: 41
              },
              this
            ) }, void 0, false, {
              fileName: "<stdin>",
              lineNumber: 298,
              columnNumber: 37
            }, this)
          ] }, void 0, true, {
            fileName: "<stdin>",
            lineNumber: 294,
            columnNumber: 33
          }, this),
          /* @__PURE__ */ jsxDEV("div", { className: "grid grid-cols-2 gap-4 text-center", children: [
            /* @__PURE__ */ jsxDEV("div", { children: [
              /* @__PURE__ */ jsxDEV("div", { className: "text-2xl font-bold text-blue-400", children: myPlayer?.[0]?.total_tips || 0 }, void 0, false, {
                fileName: "<stdin>",
                lineNumber: 308,
                columnNumber: 41
              }, this),
              /* @__PURE__ */ jsxDEV("div", { className: "text-gray-400", children: "Credits Tipped" }, void 0, false, {
                fileName: "<stdin>",
                lineNumber: 311,
                columnNumber: 41
              }, this)
            ] }, void 0, true, {
              fileName: "<stdin>",
              lineNumber: 307,
              columnNumber: 37
            }, this),
            /* @__PURE__ */ jsxDEV("div", { children: [
              /* @__PURE__ */ jsxDEV("div", { className: "text-2xl font-bold text-purple-400", children: myPlayer?.[0]?.total_prompts || 0 }, void 0, false, {
                fileName: "<stdin>",
                lineNumber: 314,
                columnNumber: 41
              }, this),
              /* @__PURE__ */ jsxDEV("div", { className: "text-gray-400", children: "Prompts Made" }, void 0, false, {
                fileName: "<stdin>",
                lineNumber: 317,
                columnNumber: 41
              }, this)
            ] }, void 0, true, {
              fileName: "<stdin>",
              lineNumber: 313,
              columnNumber: 37
            }, this)
          ] }, void 0, true, {
            fileName: "<stdin>",
            lineNumber: 306,
            columnNumber: 33
          }, this)
        ] }, void 0, true, {
          fileName: "<stdin>",
          lineNumber: 292,
          columnNumber: 29
        }, this),
        /* @__PURE__ */ jsxDEV("div", { className: "bg-black/30 backdrop-blur-lg rounded-3xl p-8 border border-green-500/30", children: [
          /* @__PURE__ */ jsxDEV("h3", { className: "text-xl font-bold text-white mb-4", children: "\u{1F4B0} Tip to Extend Life" }, void 0, false, {
            fileName: "<stdin>",
            lineNumber: 324,
            columnNumber: 33
          }, this),
          /* @__PURE__ */ jsxDEV("div", { className: "flex items-center space-x-4", children: [
            /* @__PURE__ */ jsxDEV(
              "input",
              {
                type: "number",
                min: "10",
                step: "10",
                value: tipAmount,
                onChange: (e) => setTipAmount(parseInt(e.target.value) || 10),
                className: "bg-gray-800 border border-gray-600 rounded-lg px-4 py-2 text-white flex-1",
                placeholder: "Credits"
              },
              void 0,
              false,
              {
                fileName: "<stdin>",
                lineNumber: 326,
                columnNumber: 37
              },
              this
            ),
            /* @__PURE__ */ jsxDEV("div", { className: "text-gray-400", children: [
              "= +",
              (tipAmount / CREDITS_PER_HOUR).toFixed(1),
              "h"
            ] }, void 0, true, {
              fileName: "<stdin>",
              lineNumber: 335,
              columnNumber: 37
            }, this),
            /* @__PURE__ */ jsxDEV(
              "button",
              {
                onClick: tipToSurvive,
                className: "survival-button bg-gradient-to-r from-green-500 to-emerald-600 hover:from-green-600 hover:to-emerald-700 text-white px-6 py-2 rounded-lg font-bold",
                children: "Tip & Survive"
              },
              void 0,
              false,
              {
                fileName: "<stdin>",
                lineNumber: 338,
                columnNumber: 37
              },
              this
            )
          ] }, void 0, true, {
            fileName: "<stdin>",
            lineNumber: 325,
            columnNumber: 33
          }, this),
          /* @__PURE__ */ jsxDEV("p", { className: "text-sm text-gray-400 mt-2", children: "Every 10 credits = 1 hour of survival time" }, void 0, false, {
            fileName: "<stdin>",
            lineNumber: 345,
            columnNumber: 33
          }, this)
        ] }, void 0, true, {
          fileName: "<stdin>",
          lineNumber: 323,
          columnNumber: 29
        }, this)
      ] }, void 0, true, {
        fileName: "<stdin>",
        lineNumber: 291,
        columnNumber: 25
      }, this),
      /* @__PURE__ */ jsxDEV("div", { className: "space-y-6", children: [
        /* @__PURE__ */ jsxDEV("div", { className: "bg-black/30 backdrop-blur-lg rounded-3xl p-6 border border-yellow-500/30", children: [
          /* @__PURE__ */ jsxDEV("h3", { className: "text-xl font-bold text-yellow-400 mb-4", children: "\u{1F3C6} Top Tippers" }, void 0, false, {
            fileName: "<stdin>",
            lineNumber: 354,
            columnNumber: 33
          }, this),
          /* @__PURE__ */ jsxDEV("div", { className: "space-y-2", children: leaderboardData?.[0]?.top_tippers?.slice(0, 5).map((player, index) => /* @__PURE__ */ jsxDEV("div", { className: "flex justify-between items-center text-sm", children: [
            /* @__PURE__ */ jsxDEV("span", { className: "text-gray-300", children: [
              index + 1,
              ". @",
              player.username
            ] }, void 0, true, {
              fileName: "<stdin>",
              lineNumber: 358,
              columnNumber: 45
            }, this),
            /* @__PURE__ */ jsxDEV("span", { className: "text-yellow-400 font-bold", children: player.total_tips }, void 0, false, {
              fileName: "<stdin>",
              lineNumber: 361,
              columnNumber: 45
            }, this)
          ] }, player.id, true, {
            fileName: "<stdin>",
            lineNumber: 357,
            columnNumber: 41
          }, this)) }, void 0, false, {
            fileName: "<stdin>",
            lineNumber: 355,
            columnNumber: 33
          }, this)
        ] }, void 0, true, {
          fileName: "<stdin>",
          lineNumber: 353,
          columnNumber: 29
        }, this),
        /* @__PURE__ */ jsxDEV("div", { className: "bg-black/30 backdrop-blur-lg rounded-3xl p-6 border border-purple-500/30", children: [
          /* @__PURE__ */ jsxDEV("h3", { className: "text-xl font-bold text-purple-400 mb-4", children: "\u26A1 Top Prompters" }, void 0, false, {
            fileName: "<stdin>",
            lineNumber: 370,
            columnNumber: 33
          }, this),
          /* @__PURE__ */ jsxDEV("div", { className: "space-y-2", children: leaderboardData?.[0]?.top_prompters?.slice(0, 5).map((player, index) => /* @__PURE__ */ jsxDEV("div", { className: "flex justify-between items-center text-sm", children: [
            /* @__PURE__ */ jsxDEV("span", { className: "text-gray-300", children: [
              index + 1,
              ". @",
              player.username
            ] }, void 0, true, {
              fileName: "<stdin>",
              lineNumber: 374,
              columnNumber: 45
            }, this),
            /* @__PURE__ */ jsxDEV("span", { className: "text-purple-400 font-bold", children: player.total_prompts }, void 0, false, {
              fileName: "<stdin>",
              lineNumber: 377,
              columnNumber: 45
            }, this)
          ] }, player.id, true, {
            fileName: "<stdin>",
            lineNumber: 373,
            columnNumber: 41
          }, this)) }, void 0, false, {
            fileName: "<stdin>",
            lineNumber: 371,
            columnNumber: 33
          }, this)
        ] }, void 0, true, {
          fileName: "<stdin>",
          lineNumber: 369,
          columnNumber: 29
        }, this),
        /* @__PURE__ */ jsxDEV("div", { className: "bg-black/30 backdrop-blur-lg rounded-3xl p-6 border border-blue-500/30", children: [
          /* @__PURE__ */ jsxDEV("h3", { className: "text-xl font-bold text-blue-400 mb-4", children: "\u{1F4CA} Game Stats" }, void 0, false, {
            fileName: "<stdin>",
            lineNumber: 386,
            columnNumber: 33
          }, this),
          /* @__PURE__ */ jsxDEV("div", { className: "space-y-2 text-sm", children: [
            /* @__PURE__ */ jsxDEV("div", { className: "flex justify-between", children: [
              /* @__PURE__ */ jsxDEV("span", { className: "text-gray-300", children: "Survivors" }, void 0, false, {
                fileName: "<stdin>",
                lineNumber: 389,
                columnNumber: 41
              }, this),
              /* @__PURE__ */ jsxDEV("span", { className: "text-green-400 font-bold", children: leaderboardData?.[0]?.total_alive || 0 }, void 0, false, {
                fileName: "<stdin>",
                lineNumber: 390,
                columnNumber: 41
              }, this)
            ] }, void 0, true, {
              fileName: "<stdin>",
              lineNumber: 388,
              columnNumber: 37
            }, this),
            /* @__PURE__ */ jsxDEV("div", { className: "flex justify-between", children: [
              /* @__PURE__ */ jsxDEV("span", { className: "text-gray-300", children: "Total Players" }, void 0, false, {
                fileName: "<stdin>",
                lineNumber: 395,
                columnNumber: 41
              }, this),
              /* @__PURE__ */ jsxDEV("span", { className: "text-blue-400 font-bold", children: players?.length || 0 }, void 0, false, {
                fileName: "<stdin>",
                lineNumber: 396,
                columnNumber: 41
              }, this)
            ] }, void 0, true, {
              fileName: "<stdin>",
              lineNumber: 394,
              columnNumber: 37
            }, this)
          ] }, void 0, true, {
            fileName: "<stdin>",
            lineNumber: 387,
            columnNumber: 33
          }, this)
        ] }, void 0, true, {
          fileName: "<stdin>",
          lineNumber: 385,
          columnNumber: 29
        }, this),
        /* @__PURE__ */ jsxDEV(
          "button",
          {
            onClick: checkActivity,
            className: "w-full survival-button bg-gradient-to-r from-blue-500 to-indigo-600 hover:from-blue-600 hover:to-indigo-700 text-white px-4 py-3 rounded-lg font-bold",
            children: "\u{1F504} Check Activity"
          },
          void 0,
          false,
          {
            fileName: "<stdin>",
            lineNumber: 403,
            columnNumber: 29
          },
          this
        )
      ] }, void 0, true, {
        fileName: "<stdin>",
        lineNumber: 352,
        columnNumber: 25
      }, this)
    ] }, void 0, true, {
      fileName: "<stdin>",
      lineNumber: 289,
      columnNumber: 21
    }, this),
    gameState === "dead" && /* @__PURE__ */ jsxDEV("div", { className: "max-w-2xl mx-auto text-center", children: /* @__PURE__ */ jsxDEV("div", { className: "bg-black/50 backdrop-blur-lg rounded-3xl p-8 border border-red-500/50", children: [
      /* @__PURE__ */ jsxDEV("h2", { className: "text-4xl font-bold text-red-400 mb-4", children: "\u{1F480} You Didn't Survive" }, void 0, false, {
        fileName: "<stdin>",
        lineNumber: 416,
        columnNumber: 29
      }, this),
      /* @__PURE__ */ jsxDEV("p", { className: "text-xl text-gray-300 mb-6", children: "Your survival time ran out. Better luck next season!" }, void 0, false, {
        fileName: "<stdin>",
        lineNumber: 417,
        columnNumber: 29
      }, this),
      /* @__PURE__ */ jsxDEV("div", { className: "text-gray-400", children: [
        "Season ends in ",
        getDaysUntilSeasonEnd(),
        " days"
      ] }, void 0, true, {
        fileName: "<stdin>",
        lineNumber: 420,
        columnNumber: 29
      }, this)
    ] }, void 0, true, {
      fileName: "<stdin>",
      lineNumber: 415,
      columnNumber: 25
    }, this) }, void 0, false, {
      fileName: "<stdin>",
      lineNumber: 414,
      columnNumber: 21
    }, this)
  ] }, void 0, true, {
    fileName: "<stdin>",
    lineNumber: 257,
    columnNumber: 13
  }, this) }, void 0, false, {
    fileName: "<stdin>",
    lineNumber: 256,
    columnNumber: 9
  }, this);
}
const root = createRoot(document.getElementById("root"));
root.render(/* @__PURE__ */ jsxDEV(SurvivalGame, {}, void 0, false, {
  fileName: "<stdin>",
  lineNumber: 432,
  columnNumber: 13
}));
