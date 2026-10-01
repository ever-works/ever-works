# The original brief — the owner's idea, verbatim

**Provenance.** This is the owner's original `/goal` prompt for what became the **App Works** program
(epic prefix `APW`). It was recovered on **2026-09-20** from the owner's own message of **2026-09-17**
in the DeepSeek Harness session log for this workspace
(`~/.dsh/sessions/--E-Coding-_LOCAL--/session-425792d8-…/session.v3.jsonl.zstd`, record
`user/message`, 2026-09-17T16:46:51Z), where it appears quoted under the line
_"Basically below was the plan I originally sent to him:"_ — the owner was forwarding it to a second
agent with the previous agent's hand-over.

It was originally sent to the **previous** agent (Claude Code on this PC), which is why it lived only in
that agent's context and in a chat transcript rather than in the repository. The program's own
[README §0](./README.md) is the _derived_ statement of this idea — thirteen epics, 699 tasks, 549
acceptance ids — and it is deliberately narrower than the brief below (the Selector, the SSO story and
the eventual `ever.sh` hosting idea are recorded there as scope the program only partly owns).

**Everything between the two rules is the owner's text, unedited** — including its typos — because a
source-of-intent document that has been "cleaned up" is no longer evidence of what was asked for.

---

/goal
I want you to do fully end to end research of this idea related to Ever Works platform below:

Ever Works SUPER IDEA / KILLER. Maybe some of that already done and some is not, so let's have a full PLAN on how to implement this (not run yet, just do fully research and implementation plan locally / don't push it etc):

you give repo URL when creating Work (like today you can select template, but really ANY project URL on GitHub can be such a template!)
If that repo is not yours (i.e. not in your GitHub account), Ever Works will fork it to your account
next it will RUN it as "Work" inside Ever Works platform, with Activity log and everything else we have already for each "Work" we have, same as any other Works we have, e.g. say domain, deployment target, plugins enabled, scheduled runs and so on. I.e. we essentially research repo that was provided and our AI agent decide how to provision it inside Ever Works deployment target that is selected for such work. We can have some presets for popular OSS projects too, e.g. in separate repo if that makes sense, so ones we detect how app is named / repo etc, we can search if we have such preset or not (basically maybe have like a template repos, where it does not duplicate code from original projects, but more like just describe how to run it inside Ever Works platform and refer to orgiinal GitHub repo with full source code!?) and next we can have one repo that list all such prebuilt templates for easy discovery (but of course possible to also get list of them by using -template suffix etc).
next you can chat with AI agent and it will MODIFY this software per your wish and push code back to the fork repo (and even if user want create PRs to original repo from which it was forked!!!!)
so essentially you get any software running inside your own k8s or inside our shared k8s as a "Work", fully managed by Ever Works platform etc!!!
it can also optionally not deploy it in case if you use deployment to some other hosting already and just use Ever Works to build more features etc, while keep deployment to the user!
you can also decide if you want to add that software to the "Selector" that we will have for Ever Works to switch between all Ever Platforms "Apps" (i.e. idea that all our platforms, like Ever Works, EVer Gauzy, Ever Teams, Ever Rec etc will have some nice way to jump from one platform / app to another and in this case when user get into "Ever Works" it can also allow to jump from the same component to OTHER apps that build inside Ever Works tenant as "Works" created by user. So say Ever Gauzy will be one of such Apps, Ever Works another such App etc, but user can fully customize that and add there MORE apps that he run as Works inside Ever Works (and later as ever.sh too. I.e. we can also have our "Hosting" where any apps can be deployed as is too with ever.sh etc etc etc, but all that related to ever.sh is later). We will also have SSO of course and using SSO, user can switch from one platform to another and be logged in etc and even if he switch to Ever Teams or Ever Gauzy, those can check if user has account in Ever Works and load from it list of "Apps" that exposed from this user account in Ever Works to allow to quickly switch.
End to end example: I love cal.com and they have OSS for it. So I create a new "Work" inside Ever Works and select Cal.com OSS repo https://github.com/calcom/cal.diy and it fork it to my own GitHub account (or to my Org account) and next it RUN it using some prebuilt template (if can find it in our ever-works github org by suffix "-template" in repo name) OR just using AI agent it will setup this app inside our Ever Works k8s (or user own k8s if he configured that deploy target). As result Cal.com will fully work as a "Work" inside Ever Works platform and be available online (like any other Work, on some sub-domain etc and optionally on custom domain if user configure that). Next, user can CHAT with AI agent inside Ever Works (and this is CORE thing!) and ask to modify / improve, set Missions (e.g. build my own scheduling app for XXX business) and make goals / tasks / agents etc that all will work on this "fork" of Cal.com for this specific user!

So I want you to create BEST possible plan based on research of Ever Works platform functionality we already have so I can do this 1-8 ASAP!

Why above!? Basically no platform today as I know doing this. Many HOST OSS apps, but we not just "host", we allow to modify and continuely even build your own projects on top of those!!!

---

## How the brief maps onto what was built

| The brief's sentence                                                                             | Where it lives in this program                                                                                                                                 |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "you give repo URL when creating Work … really ANY project URL on GitHub can be such a template" | **APW-01** — the `app` Work kind, `POST /api/works` with `repositoryMode`/`targetOwner`, the inspect route                                                     |
| "If that repo is not yours … will fork it to your account"                                       | **APW-02** — fork lifecycle, readiness, `createdByThisWork`, the refusals that keep a repository the platform did not create                                   |
| "presets for popular OSS projects … one repo that list all such prebuilt templates"              | **APW-03** — App Blueprints and the Apps catalog (`ever-works/templates`, `ever-works/platforms`)                                                              |
| "our AI agent decide how to provision it"                                                        | **APW-04** — the App Provisioner, the restricted sandbox agent that writes the App spec                                                                        |
| "RUN it … inside your own k8s or inside our shared k8s as a Work"                                | **APW-05** builds, **APW-06** the Kubernetes app runtime, **APW-10** the managed hosting tier                                                                  |
| "with Activity log and everything else we have already for each Work"                            | the Activity rows every outcome writes, and the existing Work surfaces the tab, pages and lanes extend                                                         |
| "chat with AI agent and it will MODIFY this software … push code back to the fork"               | **APW-08** the evolve loop, **APW-09** upstream pull requests ("even create PRs to original repo")                                                             |
| "optionally not deploy it"                                                                       | `deployProvider: none` — an App Work that builds without deploying, pinned by the `target-none` lane                                                           |
| "add that software to the 'Selector'"                                                            | **APW-11** the App Launcher and the apps registry API                                                                                                          |
| "We will also have SSO of course"                                                                | **APW-12** Ever ID (OIDC / ZITADEL)                                                                                                                            |
| "https://github.com/calcom/cal.diy"                                                              | the flagship worked example: the Cal.diy Blueprint, the golden-path lane and the provisioner recipe — the upstream facts are researched and pinned in `APW-13` |

**Deliberately outside this program**, as the brief itself marks them ("all that related to ever.sh is
later"): the `ever.sh` general hosting product, and the cross-platform Selector as a shared component of
Ever Gauzy / Ever Teams / Ever Rec rather than of Ever Works alone. APW-11 builds the Ever Works half and
the SSO contract APW-12 owns.
