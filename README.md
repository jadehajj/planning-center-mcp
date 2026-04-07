# Planning Center MCP Server

A remote [Model Context Protocol](https://modelcontextprotocol.io) server that connects Claude to Planning Center Online. Deployed on Vercel.

## Tools

| Tool | Description |
|---|---|
| `pc_list_people` | Search congregation members by name |
| `pc_get_person` | Get a full person profile by ID |
| `pc_list_services` | List upcoming service plans |
| `pc_get_service` | Get service plan detail (order of service, teams, songs) |
| `pc_list_groups` | List/search small groups |
| `pc_list_checkins` | List check-in attendance records |
| `pc_list_donations` | List giving/donation records |

## Environment Variables

Set these in Vercel:

| Variable | Description |
|---|---|
| `PCO_APP_ID` | Planning Center App ID |
| `PCO_SECRET` | Planning Center Personal Access Token Secret |

## Local Development

```bash
npm install
cp .env.example .env   # add your credentials
npm run dev            # starts local HTTP server on :3000
```

Test with MCP Inspector:
```bash
npx @modelcontextprotocol/inspector http://localhost:3000/mcp
```

## Deployment

```bash
vercel --prod
```

The MCP endpoint is: `https://<your-project>.vercel.app/mcp`

Add this URL as a custom connector in Claude at `claude.ai/settings/connectors`.

## API Reference

Planning Center uses JSON:API format. Authentication is HTTP Basic Auth with App ID as username and Secret as password.

Base URL: `https://api.planningcenteronline.com`
