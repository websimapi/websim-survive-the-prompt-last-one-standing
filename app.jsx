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
    const handleCommentCreated = async (data) => {
      const comment = data.comment;
      if (comment.card_data?.type === "tip_comment") {
        const creditsSpent = comment.card_data.credits_spent;
        const authorId = comment.author.id;
        const player = players?.find((p) => p.id === authorId);
        if (player && !player.dead) {
          const hoursToAdd = creditsSpent / CREDITS_PER_HOUR;
          await room.collection("players").upsert({
            id: authorId,
            survival_hours: player.survival_hours + hoursToAdd,
            total_tips: player.total_tips + creditsSpent,
            last_check: (/* @__PURE__ */ new Date()).toISOString()
          });
          await room.collection("tips").upsert({
            player_id: authorId,
            amount: creditsSpent,
            timestamp: comment.created_at
          });
          updateLeaderboardCache();
        }
      }
    };
    window.websim.addEventListener("comment:created", handleCommentCreated);
    return () => {
    };
  }, [players]);
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
  const fetchUserActivity = async (userId) => {
    try {
      const response = await fetch(`/api/v1/users/${userId}/projects?touched=true&sort_by=updated_at&first=50`);
      const data = await response.json();
      if (!data.projects?.data) return { prompts: 0, lastActivity: /* @__PURE__ */ new Date() };
      let recentPrompts = 0;
      let lastActivity = /* @__PURE__ */ new Date(0);
      for (const projectData of data.projects.data) {
        const project = projectData.project;
        const revision = projectData.project_revision;
        const site = projectData.site;
        if (site && revision) {
          const siteCreated = new Date(site.created_at);
          const revisionUpdated = new Date(revision.updated_at);
          const activityTime = siteCreated > revisionUpdated ? siteCreated : revisionUpdated;
          if (activityTime > lastActivity) {
            lastActivity = activityTime;
          }
          recentPrompts++;
        }
      }
      return {
        prompts: recentPrompts,
        lastActivity
      };
    } catch (error) {
      console.error("Error fetching user activity:", error);
      return { prompts: 0, lastActivity: /* @__PURE__ */ new Date() };
    }
  };
  const countPromptsSince = (activityData, sinceDate) => {
    if (!activityData.lastActivity) return 0;
    const timeSinceLastCheck = /* @__PURE__ */ new Date() - new Date(sinceDate);
    const hoursSinceCheck = timeSinceLastCheck / (1e3 * 60 * 60);
    if (activityData.lastActivity > sinceDate && hoursSinceCheck > 0) {
      const estimatedPrompts = Math.min(
        Math.floor(hoursSinceCheck * 0.5),
        // 0.5 prompts per hour average
        activityData.prompts || 1
      );
      return Math.max(1, estimatedPrompts);
    }
    return 0;
  };
  const checkAndUpdateActivity = async (playerId) => {
    try {
      const player = myPlayer[0];
      if (!player) return;
      const now = /* @__PURE__ */ new Date();
      const lastCacheUpdate = player.cached_activity_timestamp ? new Date(player.cached_activity_timestamp) : /* @__PURE__ */ new Date(0);
      const cacheAge = (now - lastCacheUpdate) / (1e3 * 60);
      let activityData;
      let newPrompts = 0;
      if (cacheAge > 5) {
        activityData = await fetchUserActivity(playerId);
        const lastCheck2 = new Date(player.last_check);
        newPrompts = countPromptsSince(activityData, lastCheck2);
      } else {
        newPrompts = 0;
      }
      const bonusMinutes = newPrompts * MINUTES_PER_PROMPT;
      const bonusHours = bonusMinutes / 60;
      const lastCheck = new Date(player.last_check);
      const timeSinceCheck = (now - lastCheck) / (1e3 * 60 * 60);
      const updatedSurvivalHours = Math.max(0, player.survival_hours - timeSinceCheck + bonusHours);
      if (updatedSurvivalHours <= 0) {
        await room.collection("players").upsert({
          id: playerId,
          dead: true,
          death_time: now.toISOString(),
          last_check: now.toISOString(),
          cached_activity_timestamp: now.toISOString()
        });
        setGameState("dead");
      } else {
        const updatedTotalPrompts = player.total_prompts + newPrompts;
        await room.collection("players").upsert({
          id: playerId,
          survival_hours: updatedSurvivalHours,
          total_prompts: updatedTotalPrompts,
          last_check: now.toISOString(),
          cached_activity_timestamp: now.toISOString()
        });
        setTimeLeft(updatedSurvivalHours * 3600);
        if (newPrompts > 0) {
          console.log(`Added ${newPrompts} prompts (+${bonusMinutes} minutes survival time)`);
        }
      }
      await updateLeaderboardCache();
    } catch (error) {
      console.error("Error checking activity:", error);
      const player = myPlayer[0];
      if (player) {
        const now = /* @__PURE__ */ new Date();
        const lastCheck = new Date(player.last_check);
        const timeSinceCheck = (now - lastCheck) / (1e3 * 60 * 60);
        const updatedSurvivalHours = Math.max(0, player.survival_hours - timeSinceCheck);
        await room.collection("players").upsert({
          id: playerId,
          survival_hours: updatedSurvivalHours,
          last_check: now.toISOString()
        });
        if (updatedSurvivalHours <= 0) {
          setGameState("dead");
        } else {
          setTimeLeft(updatedSurvivalHours * 3600);
        }
      }
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
      lineNumber: 323,
      columnNumber: 17
    }, this) }, void 0, false, {
      fileName: "<stdin>",
      lineNumber: 322,
      columnNumber: 13
    }, this);
  }
  if (gameState === "season_ended") {
    return /* @__PURE__ */ jsxDEV("div", { className: "min-h-screen bg-gradient-to-br from-red-900 via-gray-900 to-black flex items-center justify-center text-center", children: /* @__PURE__ */ jsxDEV("div", { className: "bg-black/50 backdrop-blur-lg rounded-2xl p-8 max-w-md", children: [
      /* @__PURE__ */ jsxDEV("h1", { className: "text-4xl font-bold text-red-400 mb-4", children: "Season Ended" }, void 0, false, {
        fileName: "<stdin>",
        lineNumber: 332,
        columnNumber: 21
      }, this),
      /* @__PURE__ */ jsxDEV("p", { className: "text-gray-300", children: "The survival season has concluded. Thank you for playing!" }, void 0, false, {
        fileName: "<stdin>",
        lineNumber: 333,
        columnNumber: 21
      }, this)
    ] }, void 0, true, {
      fileName: "<stdin>",
      lineNumber: 331,
      columnNumber: 17
    }, this) }, void 0, false, {
      fileName: "<stdin>",
      lineNumber: 330,
      columnNumber: 13
    }, this);
  }
  return /* @__PURE__ */ jsxDEV("div", { className: "min-h-screen bg-gradient-to-br from-purple-900 via-blue-900 to-indigo-900", children: /* @__PURE__ */ jsxDEV("div", { className: "container mx-auto px-4 py-8", children: [
    /* @__PURE__ */ jsxDEV("header", { className: "text-center mb-8", children: [
      /* @__PURE__ */ jsxDEV("h1", { className: "text-5xl font-bold text-white mb-2 glow-text", children: "Survive the Prompt" }, void 0, false, {
        fileName: "<stdin>",
        lineNumber: 343,
        columnNumber: 21
      }, this),
      /* @__PURE__ */ jsxDEV("p", { className: "text-xl text-gray-300 mb-4", children: "Last One Standing Wins" }, void 0, false, {
        fileName: "<stdin>",
        lineNumber: 346,
        columnNumber: 21
      }, this),
      /* @__PURE__ */ jsxDEV("div", { className: "text-lg text-yellow-400", children: [
        "Season ends in ",
        getDaysUntilSeasonEnd(),
        " days"
      ] }, void 0, true, {
        fileName: "<stdin>",
        lineNumber: 347,
        columnNumber: 21
      }, this)
    ] }, void 0, true, {
      fileName: "<stdin>",
      lineNumber: 342,
      columnNumber: 17
    }, this),
    gameState === "not_joined" && /* @__PURE__ */ jsxDEV("div", { className: "max-w-2xl mx-auto", children: /* @__PURE__ */ jsxDEV("div", { className: "bg-black/30 backdrop-blur-lg rounded-3xl p-8 text-center border border-purple-500/30", children: [
      /* @__PURE__ */ jsxDEV("h2", { className: "text-3xl font-bold text-white mb-6", children: "Enter the Arena" }, void 0, false, {
        fileName: "<stdin>",
        lineNumber: 355,
        columnNumber: 29
      }, this),
      /* @__PURE__ */ jsxDEV("div", { className: "space-y-4 text-gray-300 mb-8", children: [
        /* @__PURE__ */ jsxDEV("p", { children: "\u{1F3AF} Start with 24 hours to survive" }, void 0, false, {
          fileName: "<stdin>",
          lineNumber: 357,
          columnNumber: 33
        }, this),
        /* @__PURE__ */ jsxDEV("p", { children: "\u{1F4B0} +1 hour for every 10 credits tipped" }, void 0, false, {
          fileName: "<stdin>",
          lineNumber: 358,
          columnNumber: 33
        }, this),
        /* @__PURE__ */ jsxDEV("p", { children: "\u26A1 +10 minutes for every prompt since last check" }, void 0, false, {
          fileName: "<stdin>",
          lineNumber: 359,
          columnNumber: 33
        }, this),
        /* @__PURE__ */ jsxDEV("p", { children: "\u{1F480} Reach 0 hours without activity = Game Over" }, void 0, false, {
          fileName: "<stdin>",
          lineNumber: 360,
          columnNumber: 33
        }, this)
      ] }, void 0, true, {
        fileName: "<stdin>",
        lineNumber: 356,
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
          lineNumber: 362,
          columnNumber: 29
        },
        this
      )
    ] }, void 0, true, {
      fileName: "<stdin>",
      lineNumber: 354,
      columnNumber: 25
    }, this) }, void 0, false, {
      fileName: "<stdin>",
      lineNumber: 353,
      columnNumber: 21
    }, this),
    gameState === "playing" && /* @__PURE__ */ jsxDEV("div", { className: "grid lg:grid-cols-3 gap-8", children: [
      /* @__PURE__ */ jsxDEV("div", { className: "lg:col-span-2", children: [
        /* @__PURE__ */ jsxDEV("div", { className: "bg-black/30 backdrop-blur-lg rounded-3xl p-8 border border-purple-500/30 mb-6", children: [
          /* @__PURE__ */ jsxDEV("h2", { className: "text-2xl font-bold text-white mb-4", children: "Your Survival Status" }, void 0, false, {
            fileName: "<stdin>",
            lineNumber: 377,
            columnNumber: 33
          }, this),
          /* @__PURE__ */ jsxDEV("div", { className: "text-center", children: [
            /* @__PURE__ */ jsxDEV("div", { className: `text-6xl font-bold mb-4 ${timeLeft < 3600 ? "text-red-400 animate-pulse" : timeLeft < 7200 ? "text-yellow-400" : "text-green-400"}`, children: formatTime(timeLeft) }, void 0, false, {
              fileName: "<stdin>",
              lineNumber: 379,
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
                lineNumber: 383,
                columnNumber: 41
              },
              this
            ) }, void 0, false, {
              fileName: "<stdin>",
              lineNumber: 382,
              columnNumber: 37
            }, this)
          ] }, void 0, true, {
            fileName: "<stdin>",
            lineNumber: 378,
            columnNumber: 33
          }, this),
          /* @__PURE__ */ jsxDEV("div", { className: "grid grid-cols-2 gap-4 text-center", children: [
            /* @__PURE__ */ jsxDEV("div", { children: [
              /* @__PURE__ */ jsxDEV("div", { className: "text-2xl font-bold text-blue-400", children: myPlayer?.[0]?.total_tips || 0 }, void 0, false, {
                fileName: "<stdin>",
                lineNumber: 392,
                columnNumber: 41
              }, this),
              /* @__PURE__ */ jsxDEV("div", { className: "text-gray-400", children: "Credits Tipped" }, void 0, false, {
                fileName: "<stdin>",
                lineNumber: 395,
                columnNumber: 41
              }, this)
            ] }, void 0, true, {
              fileName: "<stdin>",
              lineNumber: 391,
              columnNumber: 37
            }, this),
            /* @__PURE__ */ jsxDEV("div", { children: [
              /* @__PURE__ */ jsxDEV("div", { className: "text-2xl font-bold text-purple-400", children: myPlayer?.[0]?.total_prompts || 0 }, void 0, false, {
                fileName: "<stdin>",
                lineNumber: 398,
                columnNumber: 41
              }, this),
              /* @__PURE__ */ jsxDEV("div", { className: "text-gray-400", children: "Prompts Made" }, void 0, false, {
                fileName: "<stdin>",
                lineNumber: 401,
                columnNumber: 41
              }, this)
            ] }, void 0, true, {
              fileName: "<stdin>",
              lineNumber: 397,
              columnNumber: 37
            }, this)
          ] }, void 0, true, {
            fileName: "<stdin>",
            lineNumber: 390,
            columnNumber: 33
          }, this)
        ] }, void 0, true, {
          fileName: "<stdin>",
          lineNumber: 376,
          columnNumber: 29
        }, this),
        /* @__PURE__ */ jsxDEV("div", { className: "bg-black/30 backdrop-blur-lg rounded-3xl p-8 border border-green-500/30", children: [
          /* @__PURE__ */ jsxDEV("h3", { className: "text-xl font-bold text-white mb-4", children: "\u{1F4B0} Tip to Extend Life" }, void 0, false, {
            fileName: "<stdin>",
            lineNumber: 408,
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
                lineNumber: 410,
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
              lineNumber: 419,
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
                lineNumber: 422,
                columnNumber: 37
              },
              this
            )
          ] }, void 0, true, {
            fileName: "<stdin>",
            lineNumber: 409,
            columnNumber: 33
          }, this),
          /* @__PURE__ */ jsxDEV("p", { className: "text-sm text-gray-400 mt-2", children: "Every 10 credits = 1 hour of survival time" }, void 0, false, {
            fileName: "<stdin>",
            lineNumber: 429,
            columnNumber: 33
          }, this)
        ] }, void 0, true, {
          fileName: "<stdin>",
          lineNumber: 407,
          columnNumber: 29
        }, this)
      ] }, void 0, true, {
        fileName: "<stdin>",
        lineNumber: 375,
        columnNumber: 25
      }, this),
      /* @__PURE__ */ jsxDEV("div", { className: "space-y-6", children: [
        /* @__PURE__ */ jsxDEV("div", { className: "bg-black/30 backdrop-blur-lg rounded-3xl p-6 border border-yellow-500/30", children: [
          /* @__PURE__ */ jsxDEV("h3", { className: "text-xl font-bold text-yellow-400 mb-4", children: "\u{1F3C6} Top Tippers" }, void 0, false, {
            fileName: "<stdin>",
            lineNumber: 438,
            columnNumber: 33
          }, this),
          /* @__PURE__ */ jsxDEV("div", { className: "space-y-2", children: leaderboardData?.[0]?.top_tippers?.slice(0, 5).map((player, index) => /* @__PURE__ */ jsxDEV("div", { className: "flex justify-between items-center text-sm", children: [
            /* @__PURE__ */ jsxDEV("span", { className: "text-gray-300", children: [
              index + 1,
              ". @",
              player.username
            ] }, void 0, true, {
              fileName: "<stdin>",
              lineNumber: 442,
              columnNumber: 45
            }, this),
            /* @__PURE__ */ jsxDEV("span", { className: "text-yellow-400 font-bold", children: player.total_tips }, void 0, false, {
              fileName: "<stdin>",
              lineNumber: 445,
              columnNumber: 45
            }, this)
          ] }, player.id, true, {
            fileName: "<stdin>",
            lineNumber: 441,
            columnNumber: 41
          }, this)) }, void 0, false, {
            fileName: "<stdin>",
            lineNumber: 439,
            columnNumber: 33
          }, this)
        ] }, void 0, true, {
          fileName: "<stdin>",
          lineNumber: 437,
          columnNumber: 29
        }, this),
        /* @__PURE__ */ jsxDEV("div", { className: "bg-black/30 backdrop-blur-lg rounded-3xl p-6 border border-purple-500/30", children: [
          /* @__PURE__ */ jsxDEV("h3", { className: "text-xl font-bold text-purple-400 mb-4", children: "\u26A1 Top Prompters" }, void 0, false, {
            fileName: "<stdin>",
            lineNumber: 454,
            columnNumber: 33
          }, this),
          /* @__PURE__ */ jsxDEV("div", { className: "space-y-2", children: leaderboardData?.[0]?.top_prompters?.slice(0, 5).map((player, index) => /* @__PURE__ */ jsxDEV("div", { className: "flex justify-between items-center text-sm", children: [
            /* @__PURE__ */ jsxDEV("span", { className: "text-gray-300", children: [
              index + 1,
              ". @",
              player.username
            ] }, void 0, true, {
              fileName: "<stdin>",
              lineNumber: 458,
              columnNumber: 45
            }, this),
            /* @__PURE__ */ jsxDEV("span", { className: "text-purple-400 font-bold", children: player.total_prompts }, void 0, false, {
              fileName: "<stdin>",
              lineNumber: 461,
              columnNumber: 45
            }, this)
          ] }, player.id, true, {
            fileName: "<stdin>",
            lineNumber: 457,
            columnNumber: 41
          }, this)) }, void 0, false, {
            fileName: "<stdin>",
            lineNumber: 455,
            columnNumber: 33
          }, this)
        ] }, void 0, true, {
          fileName: "<stdin>",
          lineNumber: 453,
          columnNumber: 29
        }, this),
        /* @__PURE__ */ jsxDEV("div", { className: "bg-black/30 backdrop-blur-lg rounded-3xl p-6 border border-blue-500/30", children: [
          /* @__PURE__ */ jsxDEV("h3", { className: "text-xl font-bold text-blue-400 mb-4", children: "\u{1F4CA} Game Stats" }, void 0, false, {
            fileName: "<stdin>",
            lineNumber: 470,
            columnNumber: 33
          }, this),
          /* @__PURE__ */ jsxDEV("div", { className: "space-y-2 text-sm", children: [
            /* @__PURE__ */ jsxDEV("div", { className: "flex justify-between", children: [
              /* @__PURE__ */ jsxDEV("span", { className: "text-gray-300", children: "Survivors" }, void 0, false, {
                fileName: "<stdin>",
                lineNumber: 473,
                columnNumber: 41
              }, this),
              /* @__PURE__ */ jsxDEV("span", { className: "text-green-400 font-bold", children: leaderboardData?.[0]?.total_alive || 0 }, void 0, false, {
                fileName: "<stdin>",
                lineNumber: 474,
                columnNumber: 41
              }, this)
            ] }, void 0, true, {
              fileName: "<stdin>",
              lineNumber: 472,
              columnNumber: 37
            }, this),
            /* @__PURE__ */ jsxDEV("div", { className: "flex justify-between", children: [
              /* @__PURE__ */ jsxDEV("span", { className: "text-gray-300", children: "Total Players" }, void 0, false, {
                fileName: "<stdin>",
                lineNumber: 479,
                columnNumber: 41
              }, this),
              /* @__PURE__ */ jsxDEV("span", { className: "text-blue-400 font-bold", children: players?.length || 0 }, void 0, false, {
                fileName: "<stdin>",
                lineNumber: 480,
                columnNumber: 41
              }, this)
            ] }, void 0, true, {
              fileName: "<stdin>",
              lineNumber: 478,
              columnNumber: 37
            }, this)
          ] }, void 0, true, {
            fileName: "<stdin>",
            lineNumber: 471,
            columnNumber: 33
          }, this)
        ] }, void 0, true, {
          fileName: "<stdin>",
          lineNumber: 469,
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
            lineNumber: 487,
            columnNumber: 29
          },
          this
        )
      ] }, void 0, true, {
        fileName: "<stdin>",
        lineNumber: 436,
        columnNumber: 25
      }, this)
    ] }, void 0, true, {
      fileName: "<stdin>",
      lineNumber: 373,
      columnNumber: 21
    }, this),
    gameState === "dead" && /* @__PURE__ */ jsxDEV("div", { className: "max-w-2xl mx-auto text-center", children: /* @__PURE__ */ jsxDEV("div", { className: "bg-black/50 backdrop-blur-lg rounded-3xl p-8 border border-red-500/50", children: [
      /* @__PURE__ */ jsxDEV("h2", { className: "text-4xl font-bold text-red-400 mb-4", children: "\u{1F480} You Didn't Survive" }, void 0, false, {
        fileName: "<stdin>",
        lineNumber: 500,
        columnNumber: 29
      }, this),
      /* @__PURE__ */ jsxDEV("p", { className: "text-xl text-gray-300 mb-6", children: "Your survival time ran out. Better luck next season!" }, void 0, false, {
        fileName: "<stdin>",
        lineNumber: 501,
        columnNumber: 29
      }, this),
      /* @__PURE__ */ jsxDEV("div", { className: "text-gray-400", children: [
        "Season ends in ",
        getDaysUntilSeasonEnd(),
        " days"
      ] }, void 0, true, {
        fileName: "<stdin>",
        lineNumber: 504,
        columnNumber: 29
      }, this)
    ] }, void 0, true, {
      fileName: "<stdin>",
      lineNumber: 499,
      columnNumber: 25
    }, this) }, void 0, false, {
      fileName: "<stdin>",
      lineNumber: 498,
      columnNumber: 21
    }, this)
  ] }, void 0, true, {
    fileName: "<stdin>",
    lineNumber: 341,
    columnNumber: 13
  }, this) }, void 0, false, {
    fileName: "<stdin>",
    lineNumber: 340,
    columnNumber: 9
  }, this);
}
const root = createRoot(document.getElementById("root"));
root.render(/* @__PURE__ */ jsxDEV(SurvivalGame, {}, void 0, false, {
  fileName: "<stdin>",
  lineNumber: 516,
  columnNumber: 13
}));
