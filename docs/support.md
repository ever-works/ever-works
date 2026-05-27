---
id: support
title: Support & Help
sidebar_label: Support
sidebar_position: 11
description: Get help with Ever Works - community support, documentation, troubleshooting, and enterprise solutions
---

# Support & Help

Welcome to the Ever Works support center. We're here to help you get the most out of your work website building experience.

## Getting Help

### Community Support

- **[GitHub Issues](https://github.com/ever-works/ever-works/issues)** - Report bugs, request features, or ask technical questions
- **[Discord Community](https://discord.gg/ever)** - Join our active Discord server for real-time support
- **[Stack Overflow](https://stackoverflow.com/questions/tagged/ever-works-website-template)** - Ask technical questions with the `ever-works` tag

### Professional Support

- **[Email Support](mailto:works@ever.co)** - Direct support for business inquiries
- **[Security Issues](mailto:security@ever.co)** - Report security vulnerabilities privately
- **[Enterprise Support](https://ever.co/contacts)** - Dedicated support for enterprise customers

## Documentation Resources

### Getting Started

- **[Overview](/overview)** - Understanding the platform
- **[Getting Started](/getting-started)** - Initial setup and configuration
- **[Installation Guide](/installation)** - Complete setup instructions
- **[Development Workflow](/development-workflow)** - Development best practices

### Architecture & Features

- **[Architecture](/architecture)** - System design and infrastructure
- **[Features](/features/)** - Detailed feature documentation
- **[Environment Variables](/environment-variables)** - Configuration reference

## Platform Access

### Cloud Platform

- **[Ever Works](https://ever.works)** - Build and deploy your work website

### Self-Hosted Options

- **[GitHub Repository](https://github.com/ever-works/ever-works)** - Clone and self-host your instance
- **[Docker Deployment](https://github.com/ever-works/ever-works#docker)** - Container-based installation

## Troubleshooting

### Common Issues

#### Installation Problems

- **Node.js Version**: Ensure you're using Node.js 22+ (matches the platform's `package.json` engines requirement)
- **Dependencies**: Run `pnpm install` in the project root
- **Port Conflicts**: Use `--port` flag to specify a different port

#### Build Issues

- **TypeScript Errors**: Check your TypeScript configuration
- **Missing Dependencies**: Ensure all packages are properly installed
- **Environment Variables**: Verify your `.env` file configuration

#### Runtime Issues

- **API Connection**: Check your `EVER_WORKS_API_URL` environment variable
- **Authentication**: Verify your API credentials
- **Database**: Ensure database connections are properly configured

### Debug Mode

Enable debug logging by setting environment variables:

```bash
DEBUG=ever-works:*
NODE_ENV=development
```

## Contributing

We welcome contributions from the community! Here's how you can help:

- **[Submit Pull Requests](https://github.com/ever-works/ever-works/pulls)** - Contribute code improvements
- **[Feature Requests](https://github.com/ever-works/ever-works/issues)** - Submit your ideas
- **[Roadmap](https://github.com/ever-works/ever-works/projects)** - See what's planned

When submitting contributions, we require a [Contributor Assignment Agreement (CAA)](https://gist.github.com/evereq/95f74ae09510766ffa9379006715ccfd).

## Enterprise Support

For enterprise customers, we offer:

- **Priority Support**: Dedicated support channels
- **Custom Integrations**: Tailored solutions for your needs
- **Training & Onboarding**: Get your team up to speed quickly
- **SLA Guarantees**: Service level agreements for critical deployments

Contact us at [works@ever.co](mailto:works@ever.co) for enterprise support options.

## License

Ever Works Platform is available under dual licensing:

- **[AGPL v3](https://www.gnu.org/licenses/agpl-3.0.html)** - For open source use
- **Commercial License** - For proprietary use, contact [works@ever.co](mailto:works@ever.co)

## Contact Information

- **Website**: [ever.co](https://ever.co)
- **Email**: [works@ever.co](mailto:works@ever.co)
- **Twitter**: [@everworks](https://twitter.com/everworks)
- **GitHub**: [ever-works/ever-works](https://github.com/ever-works/ever-works)

---

**Need immediate help?** Join our [Discord community](https://discord.gg/ever) for real-time support from the Ever Works team and community.
