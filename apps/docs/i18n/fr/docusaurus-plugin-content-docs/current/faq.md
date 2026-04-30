---
id: faq
title: Foire aux questions
sidebar_label: FAQ
sidebar_position: 12
---

# Foire aux questions

## Général

### Qu'est-ce que la Plateforme Ever Works ?

La **Plateforme Ever Works** est l'infrastructure backend qui alimente les sites web d'annuaires générés par IA. Elle comprend une API NestJS, un tableau de bord web Next.js, des outils CLI, des agents IA et un système de plugins — le tout organisé sous forme de monorepo Turborepo + pnpm workspaces.

### Qu'est-ce que Pinler.com ?

[Pinler.com](https://pinler.com) est un service SaaS d'annuaires construit sur la plateforme Ever Works. Il démontre un déploiement en production de la pile complète.

## Architecture

### Dans quel langage l'API est-elle écrite ?

TypeScript, utilisant le framework NestJS 11.

### La plateforme prend-elle en charge les fonctionnalités IA ?

Oui. La plateforme inclut des agents IA basés sur LangChain avec prise en charge de plusieurs fournisseurs de LLM (OpenAI, Anthropic, Google, Groq, OpenRouter, Ollama, et plus encore).

### Quels systèmes de base de données sont pris en charge ?

PostgreSQL et SQLite via TypeORM, avec prise en charge de Supabase.

## Développement

### Comment démarrer avec la plateforme ?

Consultez le [Guide de premiers pas](/getting-started) pour les prérequis, l'installation et la configuration de développement.

### Comment la plateforme est-elle structurée ?

Consultez la page [Architecture](/architecture) pour comprendre la structure du monorepo, les modules et le flux de données.

## Support

### Où puis-je obtenir de l'aide ?

Consultez la [page Support](/support) pour les canaux communautaires, les options de support professionnel et les guides de dépannage.
