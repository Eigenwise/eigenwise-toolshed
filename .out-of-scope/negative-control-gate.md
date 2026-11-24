# No negative-control gate

2026-11-16

**v1 had:** a submit gate that demanded machine proof a test fails without the change, read from console output, with waivers, markers and test-name parsing for JavaScript and Rust (about 800 lines).

**Evidence:** 18 issues, one cause: the control recognised two console formats and never used the exit code (#702, #715, #723, #725, #735, #738 to #741, #744, #758, #762, #763, #778, #800, #805, #816, #832). Gradle and other non-Node projects failed on a correct control. An executor once wrote a waiver it knew was false to get through.

**Decision:** One verify command, run once by the main session after landing. "Show it failing first" is a line in the review brief.

**Would change if:** a v2 review misses a test that cannot fail, repeatedly.
