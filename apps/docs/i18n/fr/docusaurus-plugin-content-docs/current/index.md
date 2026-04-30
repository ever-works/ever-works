---
id: index
title: Plateforme Ever Works
sidebar_label: Accueil
sidebar_position: 1
slug: /
---

# Plateforme Ever Works

La Plateforme Ever Works est l'infrastructure backend qui alimente les sites web d'annuaires générés par IA. Elle fournit des APIs REST, un pipeline de génération IA, la gestion de base de données et des outils de déploiement — le tout organisé sous forme de monorepo **Turborepo + pnpm workspaces**.

## Composants

| Composant | Technologie | Description |
|-----------|------------|-------------|
| **API** | NestJS 11 | API REST avec auth JWT, gestion des annuaires, conversations IA, déploiement |
| **Tableau de bord web** | Next.js 16 | Interface d'administration pour la gestion des annuaires et du contenu |
| **CLI** | Commander.js + esbuild | Outil en ligne de commande autonome pour les opérations d'annuaires |
| **CLI interne** | nest-commander | Outillage interne pour les tâches de maintenance |
| **@packages/agent** | LangChain, TypeORM | Agents IA, génération de données, base de données, opérations git, déploiement |
| **@packages/monitoring** | Sentry, PostHog | Suivi des erreurs et analyses produit |
| **@packages/tasks** | Trigger.dev | Traitement des tâches en arrière-plan |

## Documentation

- [Aperçu de la plateforme](./overview) — Fonctionnement de la plateforme et sa pile technologique
- [Premiers pas](./getting-started) — Prérequis, installation et configuration de développement
- [Architecture](./architecture) — Structure du monorepo, modules et flux de données
- [Fonctionnalités](./features/) — Traitement des PR communautaires, Collections, et plus
- [Référence API](./api/) — Points d'accès API REST et utilisation
- [Référence CLI](./cli/) — Utilisation de l'interface en ligne de commande et commandes
- [IA et génération](./ai-agents/) — Fournisseurs IA, pipeline de génération et routage de modèles
- [Base de données](./database) — Bases de données supportées, entités et configuration
- [Système de plugins](./plugin-system/) — État actuel et extensibilité prévue

## Communauté et ressources

- **[GitHub](https://github.com/ever-works)** — Code source et signalement de problèmes
- **[Discord](https://discord.gg/ever)** — Rejoindre la communauté
- **[FAQ](./faq)** — Foire aux questions
- **[Support](./support)** — Obtenir de l'aide et du support
