/* eslint-disable max-len */
import { HttpService } from '@nestjs/axios';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { Package, Prisma, Server, UserPackage as UserPackagePrisma } from '@prisma/client';
import * as Cookie from 'cookie';
import https from 'https';
import { customAlphabet } from 'nanoid';
import { PrismaService } from 'nestjs-prisma';
import { InjectBot } from 'nestjs-telegraf';
import PQueue from 'p-queue';
import { firstValueFrom } from 'rxjs';
import { Telegraf } from 'telegraf';
import { v4 as uuid } from 'uuid';

import { errors } from '../common/errors';
import {
  arrayToDic,
  bytesToGB,
  bytesToMB,
  convertPersianCurrency,
  getRemainingDays,
  getVlessLink,
  isSessionExpired,
  isUUID,
  jsonObjectToQueryString,
  jsonToB64Url,
  midOrder,
  roundTo,
} from '../common/helpers';
import { Context } from '../common/interfaces/context.interface';
import { MinioClientService } from '../minio/minio.service';
import { PaymentService } from '../payment/payment.service';
import { CallbackData } from '../telegram/telegram.constants';
import { User } from '../users/models/user.model';
import { BuyPackageInput } from './dto/buyPackage.input';
import { GetClientStatsFiltersInput } from './dto/getClientStatsFilters.input';
import { RenewPackageInput } from './dto/renewPackage.input';
import { ClientStat } from './models/clientStat.model';
import { UserPackage } from './models/userPackage.model';
import {
  AddClientInput,
  AuthenticatedReq,
  CreatePackageInput,
  InboundListRes,
  InboundSetting,
  OnlineInboundRes,
  SendBuyPackMessageInput,
  ServerStat,
  Stat,
  UpdateClientInput,
  UpdateClientReqInput,
} from './xui.types';

const ENDPOINTS = (domain: string) => {
  const url = `https://${domain}/v`;

  return {
    login: `${url}/login`,
    inbounds: `${url}/panel/inbound/list`,
    onlines: `${url}/panel/inbound/onlines`,
    addInbound: `${url}/panel/inbound/add`,
    addClient: `${url}/panel/inbound/addClient`,
    updateClient: (id: string) => `${url}/panel/inbound/updateClient/${id}`,
    resetClientTraffic: (email: string, inboundId: number) =>
      `${url}/panel/inbound/${inboundId}/resetClientTraffic/${email}`,
    delClient: (id: string, inboundId: number) => `${url}/panel/inbound/${inboundId}/delClient/${id}`,
    serverStatus: `${url}/server/status`,
  };
};

@Injectable()
export class XuiService {
  constructor(
    @InjectBot()
    private readonly bot: Telegraf<Context>,
    private prisma: PrismaService,
    private httpService: HttpService,
    private readonly payment: PaymentService,
    private readonly configService: ConfigService,
    private readonly minioService: MinioClientService,
  ) {
    // setTimeout(() => {
    //   void this.syncClientStats();
    // }, 2000);
  }

  private readonly logger = new Logger(XuiService.name);

  private readonly webPanel = this.configService.get('webPanelUrl');

  private readonly reportGroupId = this.configService.get('telGroup')!.report;

  private readonly loginToPanelBtn = {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: 'ورود به پنل',
            url: this.webPanel,
          },
        ],
      ],
    },
  };

  private ServerStatDic: Record<string, ServerStat[]> = {};

  async login(domain: string): Promise<string> {
    try {
      const password = this.configService.get('xui').password;
      const login = await firstValueFrom(
        this.httpService.post<{ success: boolean }>(ENDPOINTS(domain).login, `username=mamad&password=${password}`, {
          headers: {
            // eslint-disable-next-line @typescript-eslint/naming-convention
            'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
          },
          httpsAgent: new https.Agent({
            rejectUnauthorized: false,
          }),
        }),
      );
      const cookie = login?.headers['set-cookie']?.[0];

      if (!cookie) {
        throw new NotFoundException(errors.xui.accountNotFound);
      }

      return cookie;
    } catch (_error) {
      const error = _error as { response?: string };

      if (error?.response) {
        console.error(error.response);
      }

      throw new BadRequestException();
    }
  }

  async getAuthorization(serverId: string): Promise<[string, Server]> {
    const server = await this.prisma.server.findUniqueOrThrow({ where: { id: serverId, deletedAt: null } });

    if (!isSessionExpired(server.token)) {
      return [`session=${Cookie.parse(server.token).session}`, server];
    }

    const token = await this.login(server.domain);

    await this.prisma.server.update({
      where: {
        id: serverId,
        deletedAt: null,
      },
      data: {
        token,
      },
    });

    return [`session=${Cookie.parse(token).session}`, server];
  }

  async authenticatedReq<T>({ serverId, url, method, body, headers }: AuthenticatedReq) {
    const [auth, server] = await this.getAuthorization(serverId);

    const config = {
      headers: { ...(headers || {}), cookie: auth },
      httpsAgent: new https.Agent({
        rejectUnauthorized: false,
      }),
      maxContentLength: 10_485_760,
    };

    return firstValueFrom(
      method === 'get'
        ? this.httpService.get<T>(url(server.domain), config)
        : this.httpService[method]<T>(url(server.domain), body, config),
    );
  }

  async getInbounds(serverId: string): Promise<Stat[]> {
    const inbounds = await this.authenticatedReq<InboundListRes>({
      serverId,
      url: (domain) => ENDPOINTS(domain).inbounds,
      method: 'post',
    });

    if (!inbounds.data.obj) {
      throw new BadRequestException('Getting DNS records failed.');
    }

    const clientStats: Stat[] = [];
    inbounds.data.obj.forEach((item) => {
      const setting = JSON.parse(item.settings) as InboundSetting;
      clientStats.push(
        ...item.clientStats.map((stat) => ({
          ...stat,
          ...setting.clients.filter((i) => i.id).find((client) => client.email === stat.email)!,
          port: item.port,
        })),
      );
    });

    return clientStats.filter((i) => i.id);
  }

  async getOnlinesInbounds(serverId: string): Promise<string[]> {
    const inbounds = await this.authenticatedReq<OnlineInboundRes>({
      serverId,
      url: (domain) => ENDPOINTS(domain).onlines,
      method: 'post',
    });

    if (!inbounds.data.obj) {
      throw new BadRequestException('Getting online inbounds failed.');
    }

    return inbounds.data.obj;
  }

  async resetClientTraffic(clientStatId: string) {
    const clientStat = await this.prisma.clientStat.findUniqueOrThrow({
      where: { id: clientStatId },
      include: { server: true },
    });

    const res = await this.authenticatedReq<{ success: boolean }>({
      serverId: clientStat.server.id,
      url: (domain) => ENDPOINTS(domain).resetClientTraffic(clientStat.email, clientStat.server.inboundId),
      method: 'post',
    });

    if (!res.data.success) {
      throw new BadRequestException(errors.xui.addClientError);
    }
  }

  async deleteClient(clientStatId: string) {
    const clientStat = await this.prisma.clientStat.findUniqueOrThrow({
      where: { id: clientStatId },
      include: { server: true },
    });

    const res = await this.authenticatedReq<{ success: boolean }>({
      serverId: clientStat.server.id,
      url: (domain) => ENDPOINTS(domain).delClient(clientStat.id, clientStat.server.inboundId),
      method: 'post',
    });

    if (!res.data.success) {
      throw new BadRequestException(errors.xui.addClientError);
    }
  }

  /* eslint-disable sonarjs/cognitive-complexity, sonarjs/no-nested-template-literals */
  async updateFinishedPackages(stats: Stat[]) {
    const finishedTrafficPacks = stats.filter((stat) => stat.down + stat.up >= stat.total).map((stat) => stat.id);
    const finishedTimePacks = stats
      .filter((stat) => stat.expiryTime > 0 && stat.expiryTime <= Date.now())
      .map((stat) => stat.id);

    const finishedPacks = [...new Set([...finishedTrafficPacks, ...finishedTimePacks])];

    if (finishedPacks.length === 0) {
      return;
    }

    const finishedUserPacks = await this.prisma.userPackage.findMany({
      where: { statId: { in: finishedPacks }, deletedAt: null, finishedAt: null },
      include: {
        user: {
          include: {
            telegram: true,
          },
        },
        package: true,
      },
    });

    if (finishedUserPacks.length === 0) {
      return;
    }

    const finishedUserPackDic = arrayToDic(finishedUserPacks, 'statId');

    await this.prisma.userPackage.updateMany({
      where: {
        id: {
          in: finishedUserPacks.map((i) => i.id),
        },
      },
      data: {
        finishedAt: new Date(),
      },
    });

    const queue = new PQueue({ concurrency: 1, interval: 1000, intervalCap: 1 });
    const telegramQueue = new PQueue({ concurrency: 1, interval: 1000, intervalCap: 1 });

    for (const finishedTrafficPack of finishedTrafficPacks) {
      const userPack = finishedUserPackDic[finishedTrafficPack];

      if (!userPack) {
        continue;
      }

      const telegramId = userPack?.user?.telegram?.id ? Number(userPack.user.telegram.id) : undefined;

      if (telegramId) {
        const text = `${userPack.user.firstname} جان حجم بسته‌ی ${userPack.package.traffic} گیگ ${userPack.package.expirationDays} روزه به نام "${userPack.name}" به پایان رسید. از طریق پنل می‌تونی تمدید کنی.`;
        void telegramQueue.add(() => this.bot.telegram.sendMessage(telegramId, text, this.loginToPanelBtn));
      }

      void queue.add(() => this.deleteClient(userPack.statId));
    }

    for (const finishedTimePack of finishedTimePacks) {
      const userPack = finishedUserPackDic[finishedTimePack];

      if (!userPack) {
        continue;
      }

      const telegramId = userPack?.user?.telegram?.id ? Number(userPack.user.telegram.id) : undefined;

      if (telegramId) {
        const text = `${userPack.user.firstname} جان زمان بسته‌ی ${userPack.package.traffic} گیگ ${userPack.package.expirationDays} روزه به نام "${userPack.name}" به پایان رسید. از طریق پنل می‌تونی تمدید کنی.`;
        void telegramQueue.add(() => this.bot.telegram.sendMessage(telegramId, text, this.loginToPanelBtn));
      }

      void queue.add(() => this.deleteClient(userPack.statId));
    }
  }

  async sendThresholdWarning(stats: Stat[]) {
    const thresholdTrafficPacks = stats
      .filter((stat) => stat.down + stat.up >= stat.total * 0.85)
      .map((pack) => pack.id);

    const thresholdTimePacks = stats.filter((stat) => getRemainingDays(stat.expiryTime) <= 2).map((pack) => pack.id);

    const allThresholdPacks = [...new Set([...thresholdTrafficPacks, ...thresholdTimePacks])];

    if (allThresholdPacks.length === 0) {
      return;
    }

    const thresholdUserPacks = await this.prisma.userPackage.findMany({
      where: { statId: { in: allThresholdPacks }, deletedAt: null, thresholdWarningSentAt: null },
      include: {
        user: {
          include: {
            telegram: true,
          },
        },
        package: true,
      },
    });

    if (thresholdUserPacks.length === 0) {
      return;
    }

    const thresholdUserPackDic = arrayToDic(thresholdUserPacks, 'statId');
    await this.prisma.userPackage.updateMany({
      where: {
        id: {
          in: thresholdUserPacks.map((i) => i.id),
        },
      },
      data: {
        thresholdWarningSentAt: new Date(),
      },
    });

    const queue = new PQueue({ concurrency: 1, interval: 1000, intervalCap: 1 });

    for (const thresholdTrafficPack of thresholdTrafficPacks) {
      const userPack = thresholdUserPackDic[thresholdTrafficPack];

      if (!userPack) {
        continue;
      }

      const telegramId = userPack?.user?.telegram?.id ? Number(userPack.user.telegram.id) : undefined;

      if (telegramId) {
        const text = `${userPack.user.firstname} جان ۸۵ درصد حجم بسته‌ی ${userPack.package.traffic} گیگ ${userPack.package.expirationDays} روزه به نام "${userPack.name}" را مصرف کرده‌اید. از طریق پنل می‌تونی تمدید کنی.`;
        void queue.add(() => this.bot.telegram.sendMessage(telegramId, text, this.loginToPanelBtn));
      }
    }

    for (const thresholdTimePack of thresholdTimePacks) {
      const userPack = thresholdUserPackDic[thresholdTimePack];

      if (!userPack) {
        continue;
      }

      const telegramId = userPack?.user?.telegram?.id ? Number(userPack.user.telegram.id) : undefined;

      if (telegramId) {
        const text = `${userPack.user.firstname} جان دو روز دیگه زمان بسته‌ی ${userPack.package.traffic} گیگ ${userPack.package.expirationDays} روزه به نام "${userPack.name}" تموم میشه. از طریق پنل می‌تونی تمدید کنی.`;
        void queue.add(() => this.bot.telegram.sendMessage(telegramId, text, this.loginToPanelBtn));
      }
    }
  }

  async upsertClientStats(stats: Stat[], serverId: string, onlinesStat: string[]) {
    if (stats.length === 0) {
      return; // Nothing to upsert
    }

    const onlineStatDic = stats.reduce<Record<number, Date>>(
      (dic, stat) => (onlinesStat.includes(stat.email) ? { ...dic, [stat.id]: Date.now() } : dic),
      {},
    );

    await this.sendThresholdWarning(stats);
    await this.updateFinishedPackages(stats);
    const updatedValues: Prisma.Sql[] = [];

    // ? Prisma.sql`to_timestamp(${onlineStatDic[stat.id]} / 1000.0)`

    for (const stat of stats) {
      const lastConnectedAtSQL = onlineStatDic[stat.id]
        ? Prisma.sql`to_timestamp(${onlineStatDic[stat.id]} / 1000.0)`
        : Prisma.sql`NULL`;

      const statSql = Prisma.sql`(${stat.id}::uuid, ${stat.enable}, ${stat.email}, ${stat.up}, ${stat.down}, ${
        stat.total
      }, ${stat.expiryTime}, to_timestamp(${Date.now()} / 1000.0), ${serverId}::uuid, ${stat.flow}, ${stat.subId}, ${
        stat.tgId
      }, ${stat.limitIp || 0}, ${lastConnectedAtSQL})`;
      updatedValues.push(statSql);
    }

    try {
      await this.prisma.$queryRaw`
        INSERT INTO "ClientStat"  (id, "enable", email, up, down, total, "expiryTime", "updatedAt", "serverId", "flow", "subId", "tgId", "limitIp", "lastConnectedAt")
        VALUES ${Prisma.join(updatedValues)}
        ON CONFLICT (id) DO UPDATE
        SET
          id = EXCLUDED.id,
          "enable" = EXCLUDED."enable",
          email = EXCLUDED.email,
          up = EXCLUDED.up,
          down = EXCLUDED.down,
          total = EXCLUDED.total,
          "expiryTime" = EXCLUDED."expiryTime",
          "updatedAt" = EXCLUDED."updatedAt",
          "serverId" = EXCLUDED."serverId",
          "flow" = EXCLUDED."flow",
          "subId" = EXCLUDED."subId",
          "tgId" = EXCLUDED."tgId",
          "limitIp" = EXCLUDED."limitIp",
          "lastConnectedAt" = CASE WHEN EXCLUDED."lastConnectedAt" IS NOT NULL THEN EXCLUDED."lastConnectedAt" ELSE "ClientStat"."lastConnectedAt" END
      `;
    } catch (error) {
      console.error('Error upserting ClientStats:', error);
    }
  }

  async buyPackage(user: User, input: BuyPackageInput): Promise<UserPackagePrisma> {
    const nanoid = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 16);
    const isBlocked = Boolean(user.isDisabled || user.isParentDisabled);

    if (isBlocked) {
      throw new BadRequestException('Your account is blocked!');
    }

    const server = await this.prisma.server.findUniqueOrThrow({ where: { domain: 'ir1.arvanvpn.online:40005' } });
    const pack = await this.prisma.package.findUniqueOrThrow({ where: { id: input.packageId } });
    const paymentId = uuid();
    const email = nanoid();
    const id = uuid();
    const subId = nanoid();

    await this.addClient(user, {
      id,
      subId,
      email,
      serverId: server.id,
      package: pack,
      name: input.name || 'No Name',
    });

    const { receiptBuffer, parentProfit, profitAmount } = await this.payment.paymentRequest(user, {
      amount: pack.price,
      type: 'PACKAGE_PURCHASE',
      id: paymentId,
      receipt: input.receipt,
    });

    const lastUserPack = await this.prisma.userPackage.findFirst({
      where: { userId: user.id },
      orderBy: { order: 'asc' },
    });

    const userPack = await this.createPackage(user, {
      id,
      subId,
      email,
      server,
      name: input.name || 'No Name',
      package: pack,
      paymentId,
      order: midOrder('', lastUserPack?.order || ''),
    });

    await this.sendBuyPackMessage(user, {
      inRenew: false,
      pack,
      parentProfit,
      profitAmount,
      receiptBuffer,
      userPack,
    });

    return userPack;
  }

  async renewPackage(user: User, input: RenewPackageInput): Promise<UserPackagePrisma> {
    const userPack = await this.prisma.userPackage.findUniqueOrThrow({
      where: { id: input.userPackageId },
      include: {
        server: true,
        stat: true,
        package: true,
      },
    });
    const pack = await this.prisma.package.findUniqueOrThrow({ where: { id: input.packageId } });
    const paymentId = uuid();

    await this.prisma.userPackage.update({
      where: {
        id: userPack.id,
      },
      data: {
        deletedAt: new Date(),
      },
    });

    const modifiedPack = { ...pack };

    try {
      if (!userPack.finishedAt) {
        const remainingDays = (Number(userPack.stat.expiryTime) - Date.now()) / (1000 * 60 * 60 * 24);
        const remainingTraffic = bytesToGB(Number(userPack.stat.total - (userPack.stat.down + userPack.stat.up)));

        const maxTransformableExpirationDays =
          (remainingTraffic / userPack.package.traffic) * userPack.package.expirationDays;
        const maxTransformableTraffic = (remainingDays / userPack.package.expirationDays) * userPack.package.traffic;

        modifiedPack.traffic += remainingTraffic > maxTransformableTraffic ? maxTransformableTraffic : remainingTraffic;
        modifiedPack.expirationDays +=
          remainingDays > maxTransformableExpirationDays ? maxTransformableExpirationDays : remainingDays;

        await this.resetClientTraffic(userPack.statId);

        await this.updateClient(user, {
          id: userPack.statId,
          email: userPack.stat.email,
          subId: userPack.stat.subId,
          name: userPack.name,
          order: userPack.order,
          package: modifiedPack,
          server: userPack.server,
          enable: userPack.stat.enable,
        });

        const { receiptBuffer, parentProfit, profitAmount } = await this.payment.paymentRequest(user, {
          amount: pack.price,
          type: 'PACKAGE_PURCHASE',
          id: paymentId,
          receipt: input.receipt,
        });

        const userNewPack = await this.createPackage(user, {
          id: userPack.statId,
          subId: userPack.stat.subId,
          email: userPack.stat.email,
          server: userPack.server,
          name: userPack.name,
          package: modifiedPack,
          paymentId,
          order: userPack.order,
        });

        await this.sendBuyPackMessage(user, {
          inRenew: true,
          pack,
          userPack: userNewPack,
          parentProfit,
          profitAmount,
          receiptBuffer,
        });

        return userNewPack;
      }
    } catch {
      // nothing
    }

    await this.addClient(user, {
      id: userPack.statId,
      subId: userPack.stat.subId,
      email: userPack.stat.email,
      serverId: userPack.server.id,
      package: modifiedPack,
      name: userPack.name,
      order: userPack.order,
    });

    const { receiptBuffer, parentProfit, profitAmount } = await this.payment.paymentRequest(user, {
      amount: pack.price,
      type: 'PACKAGE_PURCHASE',
      id: paymentId,
      receipt: input.receipt,
    });

    const userNewPack = await this.createPackage(user, {
      id: userPack.statId,
      subId: userPack.stat.subId,
      email: userPack.stat.email,
      server: userPack.server,
      name: userPack.name,
      package: modifiedPack,
      paymentId,
      order: userPack.order,
    });

    await this.sendBuyPackMessage(user, {
      inRenew: true,
      pack,
      userPack: userNewPack,
      parentProfit,
      profitAmount,
      receiptBuffer,
    });

    return userNewPack;
  }

  async sendBuyPackMessage(user: User, input: SendBuyPackMessageInput) {
    const caption = `${input.inRenew ? '#تمدیدـبسته' : '#خریدـبسته'}\n📦 ${
      input.pack.traffic
    } گیگ - ${convertPersianCurrency(input.pack.price)} - ${input.pack.expirationDays} روزه\n🔤 نام بسته: ${
      input.userPack.name
    }\n👤 ${user.firstname} ${user.lastname}\n📞 موبایل: +98${user.phone}\n💵 سود تقریبی: ${convertPersianCurrency(
      roundTo(input.parentProfit || input.profitAmount || 0, 0),
    )}\n`;

    if (user.parentId) {
      const telegramUser = await this.prisma.telegramUser.findUnique({ where: { userId: user.parentId } });

      if (input.receiptBuffer) {
        const rejectData = { R_PACK: input.userPack.id } as CallbackData;
        const acceptData = { A_PACK: input.userPack.id } as CallbackData;

        if (telegramUser) {
          await this.bot.telegram.sendPhoto(
            Number(telegramUser.id),
            { source: input.receiptBuffer },
            {
              caption,
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      callback_data: jsonToB64Url(rejectData as Record<string, string>),
                      text: '❌ رد',
                    },
                    {
                      callback_data: jsonToB64Url(acceptData as Record<string, string>),
                      text: '✅ تایید',
                    },
                  ],
                ],
              },
            },
          );
        }

        const parent = await this.prisma.user.findUnique({ where: { id: user.parentId } });
        const reportCaption =
          caption +
          `\n\n👨 مارکتر: ${parent?.firstname} ${parent?.lastname}\n💵 شارژ حساب: ${convertPersianCurrency(
            roundTo(parent?.balance || 0, 0),
          )}`;
        void this.bot.telegram.sendPhoto(
          this.reportGroupId,
          { source: input.receiptBuffer },
          { caption: reportCaption },
        );

        return;
      }
    }

    const updatedUser = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    const reportCaption = caption + `\n💵 شارژ حساب: ${convertPersianCurrency(roundTo(updatedUser?.balance || 0, 0))}`;
    await this.bot.telegram.sendMessage(this.reportGroupId, reportCaption);
  }

  async getUserPackages(user: User): Promise<UserPackage[]> {
    const userPackages: UserPackage[] = [];
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const userPacks = await this.prisma.userPackage.findMany({
      include: {
        stat: true,
        server: true,
      },
      where: {
        userId: user.id,
        deletedAt: null,
        OR: [{ finishedAt: null }, { finishedAt: { gte: tenDaysAgo } }],
      },
      orderBy: {
        order: 'asc',
      },
    });

    for (const userPack of userPacks) {
      userPackages.push({
        id: userPack.id,
        createdAt: userPack.createdAt,
        updatedAt: userPack.updatedAt,
        name: userPack.name,
        link: getVlessLink(
          userPack.statId,
          userPack.server.domain,
          `${userPack.name} | ${new URL(this.webPanel).hostname}`,
        ),
        remainingTraffic: userPack.stat.total - (userPack.stat.down + userPack.stat.up),
        totalTraffic: userPack.stat.total,
        expiryTime: userPack.stat.expiryTime,
        lastConnectedAt: userPack.stat?.lastConnectedAt,
      });
    }

    return userPackages;
  }

  async addClient(_user: User, input: AddClientInput): Promise<void> {
    const server = await this.prisma.server.findUniqueOrThrow({ where: { id: input.serverId } });

    const nanoid = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 16);
    const email = input?.email || nanoid();
    const id = input?.id || uuid();
    const subId = input?.subId || nanoid();
    const jsonData = {
      id: server.inboundId,
      settings: {
        clients: [
          {
            id,
            flow: '',
            email,
            limitIp: input.package.userCount,
            totalGB: 1024 * 1024 * 1024 * input.package.traffic,
            expiryTime: Date.now() + 24 * 60 * 60 * 1000 * input.package.expirationDays,
            enable: true,
            tgId: '',
            subId,
          },
        ],
      },
    };

    const params = jsonObjectToQueryString(jsonData);

    const res = await this.authenticatedReq<{ success: boolean }>({
      serverId: input.serverId,
      url: (domain) => ENDPOINTS(domain).addClient,
      method: 'post',
      body: params,
    });

    if (!res.data.success) {
      throw new BadRequestException(errors.xui.addClientError);
    }
  }

  async createPackage(user: User, input: CreatePackageInput): Promise<UserPackagePrisma> {
    try {
      const clientStat = {
        id: input.id,
        down: 0,
        up: 0,
        flow: '',
        tgId: '',
        subId: input.subId,
        limitIp: input.package.userCount,
        total: roundTo(1024 * 1024 * 1024 * input.package.traffic, 0),
        serverId: input.server.id,
        expiryTime: roundTo(Date.now() + 24 * 60 * 60 * 1000 * input.package.expirationDays, 0),
        enable: true,
        email: input.email,
      };

      const [_, userPackage] = await this.prisma.$transaction([
        this.prisma.clientStat.upsert({
          where: {
            id: input.id,
          },
          create: clientStat,
          update: clientStat,
        }),
        this.prisma.userPackage.create({
          data: {
            packageId: input.package.id,
            serverId: input.server.id,
            userId: user.id,
            statId: input.id,
            paymentId: input.paymentId,
            name: input.name,
            order: input.order,
          },
        }),
      ]);

      return userPackage;
    } catch (error) {
      console.error(error);

      throw new BadRequestException('upsert client Stat or create userPackage got failed.');
    }
  }

  async updateClientReq(input: UpdateClientReqInput) {
    const clientStat = await this.prisma.clientStat.findUniqueOrThrow({
      where: { id: input.id },
      include: { server: true },
    });

    const jsonData = {
      id: clientStat.server.inboundId,
      settings: {
        clients: [
          {
            flow: clientStat.flow,
            email: clientStat.email,
            limitIp: clientStat.limitIp,
            totalGB: Number(clientStat.total),
            expiryTime: Number(clientStat.expiryTime),
            enable: clientStat.enable,
            tgId: clientStat.tgId,
            subId: clientStat.subId,
            ...input,
          },
        ],
      },
    };

    const params = jsonObjectToQueryString(jsonData);

    const res = await this.authenticatedReq<{ success: boolean }>({
      serverId: clientStat.server.id,
      url: (domain) => ENDPOINTS(domain).updateClient(clientStat.id),
      method: 'post',
      body: params,
    });

    if (!res.data.success) {
      throw new BadRequestException(errors.xui.addClientError);
    }
  }

  async toggleClientState(clientId: string, state: boolean) {
    await this.updateClientReq({
      id: clientId,
      enable: state,
    });
  }

  async updateClient(_user: User, input: UpdateClientInput): Promise<void> {
    await this.updateClientReq({
      id: input.id,
      expiryTime: roundTo(Date.now() + 24 * 60 * 60 * 1000 * input.package.expirationDays, 0),
      limitIp: input.package.userCount,
      totalGB: roundTo(1024 * 1024 * 1024 * input.package.traffic, 0),
      enable: input.enable,
    });
  }

  async getClientStats(filters?: GetClientStatsFiltersInput): Promise<ClientStat[]> {
    try {
      return this.prisma.clientStat.findMany({
        where: {
          ...(filters?.id && {
            id: {
              equals: filters.id,
            },
          }),
          // ...(filters?.email && {
          //   email: {
          //     contains: filters.email,
          //   },
          // }),
        },
      });
    } catch {
      throw new BadRequestException('Get ClientStats failed.');
    }
  }

  async getPackages(user: User) {
    return this.prisma.package.findMany({
      where: { deletedAt: null, forRole: { has: user.role } },
      orderBy: { order: 'asc' },
    });
  }

  async acceptPurchasePack(userPackId: string): Promise<void> {
    const userPack = await this.prisma.userPackage.findUniqueOrThrow({ where: { id: userPackId } });
    await this.prisma.payment.update({
      where: {
        id: userPack.paymentId!,
      },
      data: {
        status: 'APPLIED',
      },
    });
  }

  async rejectPurchasePack(userPackId: string): Promise<void> {
    const userPack = await this.prisma.userPackage.findUniqueOrThrow({
      where: { id: userPackId },
      include: {
        user: true,
        package: true,
      },
    });
    // const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userPack.userId } });
    const payment = await this.prisma.payment.update({
      where: {
        id: userPack.paymentId!,
      },
      data: {
        status: 'REJECTED',
      },
    });

    await this.prisma.user.update({
      where: {
        id: userPack.user.parentId!,
      },
      data: {
        balance: {
          increment: payment.amount,
        },
        profitBalance: {
          increment: payment.parentProfit,
        },
        totalProfit: {
          decrement: payment.parentProfit,
        },
      },
    });

    await this.prisma.userPackage.update({
      where: { id: userPackId },
      data: {
        deletedAt: new Date(),
      },
    });

    await this.deleteClient(userPack.statId);
    await this.toggleUserBlock(userPack.userId, true);

    const parent = await this.prisma.user.findUniqueOrThrow({ where: { id: userPack.user.parentId! } });
    const text = `#ریجکتـبسته\n📦 ${userPack.package.traffic} گیگ - ${convertPersianCurrency(
      userPack.package.price,
    )} - ${userPack.package.expirationDays} روزه\n🔤 نام بسته: ${userPack.name}\n👤 خریدار: ${
      userPack.user.firstname
    } ${userPack.user.firstname}\n👨 مارکتر: ${parent?.firstname} ${parent?.lastname}`;
    void this.bot.telegram.sendMessage(this.reportGroupId, text, this.loginToPanelBtn);
  }

  async toggleUserBlock(userId: string, isBlocked: boolean) {
    const userPacks = await this.prisma.userPackage.findMany({
      where: {
        userId,
        deletedAt: null,
      },
    });

    const children = await this.prisma.user.findMany({
      where: {
        parentId: userId,
        ...(isBlocked
          ? {}
          : {
              isDisabled: false,
            }),
      },
    });

    const childrenIds = children.map((child) => child.id);

    const childrenPacks = await this.prisma.userPackage.findMany({
      where: {
        userId: {
          in: childrenIds,
        },
        deletedAt: null,
      },
    });

    const allStatIds = [...childrenPacks, ...userPacks].map((i) => i.statId);

    const queue = new PQueue({ concurrency: 1, interval: 1000, intervalCap: 1 });

    for (const [i, statId] of allStatIds.entries()) {
      void queue.add(() => this.toggleClientState(statId, !isBlocked));
    }

    await this.prisma.user.update({
      where: {
        id: userId,
      },
      data: {
        isDisabled: isBlocked,
      },
    });

    await this.prisma.user.updateMany({
      where: {
        id: {
          in: childrenIds,
        },
      },
      data: {
        isParentDisabled: isBlocked,
      },
    });
  }

  // @Interval('getServerStatus', 0.25 * 60 * 1000)
  async getServerStatus(): Promise<void> {
    const servers = await this.prisma.server.findMany({ where: { deletedAt: null } });

    for (const server of servers) {
      try {
        const status = await this.authenticatedReq({
          serverId: server.id,
          url: (domain) => ENDPOINTS(domain).serverStatus,
          method: 'post',
        });

        console.log('server ==>', status.data);
      } catch (error) {
        console.error(error);
      }
    }
  }

  async fixOrder() {
    this.logger.debug('fixOrder');
    const users = await this.prisma.user.findMany();

    for (const user of users) {
      try {
        const userPacks = await this.prisma.userPackage.findMany({
          where: { userId: user.id },
          orderBy: { order: 'desc' },
        });

        let lastOrder = 'n';

        for (const userPack of userPacks) {
          await this.prisma.userPackage.update({ where: { id: userPack.id }, data: { order: lastOrder } });
          lastOrder = midOrder('', lastOrder);
        }
        // Upsert ClientStat records in bulk
      } catch (error) {
        console.error('Error fixOrder', error);
      }
    }
  }

  // @Interval('syncClientStats', 0.25 * 60 * 1000)
  @Interval('syncClientStats', 1 * 60 * 1000)
  async syncClientStats() {
    this.logger.debug('SyncClientStats called every 1 min');
    const servers = await this.prisma.server.findMany({ where: { deletedAt: null } });

    for (const server of servers) {
      try {
        const updatedClientStats = (await this.getInbounds(server.id)).filter((i) => isUUID(i.id));
        const onlinesStat = await this.getOnlinesInbounds(server.id);
        // Upsert ClientStat records in bulk
        await this.upsertClientStats(updatedClientStats, server.id, onlinesStat);
      } catch (error) {
        console.error(`Error syncing ClientStats for server: ${server.id}`, error);
      }
    }
  }
}
