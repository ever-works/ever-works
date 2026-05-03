---
id: faq
title: Frequently Asked Questions
sidebar_label: FAQ
sidebar_position: 12
---

# Frequently Asked Questions

## General

### What is the difference between the Platform and the Template?

The **Template** is a standalone, production-ready Next.js website you can clone, customize, and deploy. The **Platform** is the backend infrastructure (APIs, AI agents, plugin system) that can power one or many work websites at scale.

### Can I use the Template without the Platform?

Yes. The Template works independently as a self-contained Next.js application with its own API routes, authentication, and database.

### What is Pinler.com?

[Pinler.com](https://pinler.com) is a SaaS work service built on top of the Ever Works Platform and Template. It demonstrates a production deployment of the full Ever Works stack.

## Template

### What technologies does the Template use?

Next.js 15, React 19, TypeScript, Tailwind CSS, HeroUI React, Prisma ORM, PostgreSQL, and Supabase.

### Which authentication providers are supported?

Google, GitHub, Facebook, Twitter, and Microsoft via NextAuth.js v5, plus Supabase Auth.

### Which payment providers are supported?

Stripe, LemonSqueezy, and Polar with subscription management support.

### How do I deploy the Template?

See the [Deployment Guide](/devops/docker) for instructions on deploying to Vercel, Docker, or cloud providers.

## Platform

### What language is the Platform API written in?

TypeScript, using the NestJS framework.

### Does the Platform support AI features?

Yes. The Platform includes LangChain-based AI agents with support for multiple LLM providers (OpenAI, Anthropic, Google, and more).

## Support

### Where can I get help?

See the [Support page](/support) for community channels, professional support options, and troubleshooting guides.
