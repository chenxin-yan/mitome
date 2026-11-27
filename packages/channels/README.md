# @mitome/channels

First-party Channel Hosts. The current `@mitome/channels/http` implementation uses Promise Host contracts and connection-owned execution; it does not implement accepted-work recovery or durable pending Approvals.

The accepted redesign includes mountable HTTP initially, with Discord/Telegram deferred. Obsolete HTTP/Host guides have been removed; see the [library plan](https://github.com/chenxin-yan/mitome/blob/main/docs/plans/effect-native-library.md). No new wire/API contract is shipped by this documentation change.
