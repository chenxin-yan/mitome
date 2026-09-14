# @mitome/channels

First-party Channel Hosts for Mitome Agents. The package has no root import; each Channel ships on its own subpath and takes its Route store through its factory options. `@mitome/channels/http` serves an Agent over plain HTTP with Turns streamed as Server-Sent Events; `@mitome/channels/telegram` connects a Telegram bot by long polling.

```sh
npm install @mitome/sdk @mitome/channels
```

The HTTP contract is described under [Channels](https://mitome.sh/docs/channels), the Telegram Channel under [Telegram](https://mitome.sh/docs/telegram); Hosts and Channels in general under [Hosts](https://mitome.sh/docs/hosts).
