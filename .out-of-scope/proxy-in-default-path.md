# No proxy in the default path

2026-11-16

**v1 had:** a local gateway, a supervisor and a third-party proxy binary in front of the session whenever it was installed, with Sidequest defaults rewritten when it was ready.

**Evidence:** 40 environment knobs, 27 state files and two ports. 101 releases in 107 days. A supervisor probe killed the supervisor through PID reuse (#747). A proxy bump on 2026-07-14 invalidated stored credentials and left the whole board undispatchable, because every route pointed at it.

**Decision:** Installing the gateway changes nothing. Non-Claude models are routing values a user adds on purpose, run in a separate process for the executor only. A dead gateway fails one dispatch with one line.

**Would change if:** the host offers a supported way to route a single model without a proxy.
