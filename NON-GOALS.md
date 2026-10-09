# Non-Goals

This document exists so these questions are answered once, in writing, instead of in
every issue thread. If you are here because you filed a request that was closed with a
link to this file, the relevant section explains why. It is not a judgment of the idea,
only a statement that it is outside what this project is.

GPC Inspector reports **facts** about how a website responded to the Global Privacy
Control signal. It does not block, judge, or advise. Everything below follows from that.

## This project will not block trackers

There are excellent tools for that: uBlock Origin, Privacy Badger, DuckDuckGo. Blocking
is a different job with a different failure mode, and it is fundamentally incompatible
with this tool's purpose. An inspector that blocks a request can no longer observe what
the site *would* have done with it: blocking destroys the evidence. The whole value here
is showing you what actually happened, and you cannot both prevent a thing and measure it.

## This project will not collect analytics or usage data

No telemetry, no usage counters, no crash reporter, no error beacon, no "check for
updates" ping carrying a version string. The extension makes exactly one network request
of its own: reading a site's published `/.well-known/gpc.json`, which goes to the site you
are already visiting and is controllable in Settings. Nothing else leaves the
device, and nothing at all is sent to us.

We considered it seriously. There is no way to know whether anyone opens the Requests tab,
whether the first-run disclosure is read or dismissed, or which findings people act on, and
every design decision in this project has been made from a handful of hand-tested sites and
intuition. That is a real cost and it is accepted knowingly.

The reasons it is not worth paying:

**Nothing the extension observes leaves the device, and the store listing says so.** From
1.0.0 the listing's privacy section also names the data the extension handles on the device
(the pages and requests it observes, page text, cookies), because the Chrome Web Store asks
for handling to be disclosed even when nothing is transmitted; its privacy policy says none
of it leaves the device. That promise is why a privacy tool asking
to read every page you visit is credible at all, and it is a one-way door: "we started
collecting data" is a headline this project does not need and could not outrun.

**A tool whose argument is that sites should honor a stated preference cannot itself
collect behavioral data.** The optics are not incidental; they are the thesis pointed back
at itself. This is the one product where the usual "it's anonymised and aggregated"
defense is unavailable, because the whole point is that people are entitled to say no.

**The correctness question has a better answer.** Analytics would have been most valuable
for finding wrong results, and the "Finding looks wrong" flow does that directly, through a route
that collects nothing and shows the person exactly what they are sending before they send
it. A report from someone looking at their own site is worth more than a usage counter.

**Some of it is free.** The Chrome Web Store reports installs, weekly active users,
uninstall rate, ratings and reviews without any telemetry.

**What must not happen is drift.** A crash reporter, an error beacon, a list-version ping:
each is individually defensible and collectively a data collection program that nobody
decided to build. That is why this is written down rather than left as a disposition.

Revisiting requires a specific question the data would answer that cannot be answered
another way. "We would like to know how it is used" is not that question.

## This project will not render verdicts, scores, or grades

You will not see "this site passed," "this site failed," "compliant," "non-compliant,"
or "violation" anywhere in the UI. Those are legal conclusions. This tool cannot see a
site's service-provider contracts, its account-level opt-out state, whether it meets a
law's applicability thresholds, or which US state's law the visitor falls under, so it
is not equipped to reach those conclusions, and it will not pretend to be. It reports the
artifact ("a cookie was set on a request carrying your signal") and links the relevant
regulatory text. You draw the conclusion.

This is not timidity. A single well-publicized false accusation ends a project whose only
asset is being right. The wording rule (CONTRIBUTING.md, Rule 1) is
enforced in CI: the website is never the subject of a verb about intent.

## This project will not report to regulators or to the sites themselves

No auto-filing of complaints with any Attorney General or privacy agency. A flood of
tool-generated complaints, most of them technically shaky, would poison the credibility
of the few that matter. And "report to the site" is the site's own Do-Not-Sell link,
which already exists and does nothing this tool needs to duplicate.

## This project will not collect your data

No telemetry. No analytics. No anonymous counters that leave your device. Not off by
default: absent. Observation of the pages you visit happens entirely locally and never
transmits. The Chrome Web Store listing names what the extension handles on the device and
certifies that none of it is sold, transferred or used for anything else, and that will
remain true. The one deliberate exception is the "Finding looks wrong" button, which
opens a **pre-filled GitHub issue you review and submit yourself**. Nothing is sent
without your explicit action, and you see the full payload first.

## This project will not test what a browser cannot see

Server-side tagging, CNAME-cloaked subdomains (Chrome has no DNS API), account-level and
cross-device opt-out state: these are invisible from a browser extension by construction.
Rather than guess, the UI names these as blind spots. A tool that inferred them would be
inventing findings, which is the opposite of the point.

