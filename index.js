require('dotenv').config();
const os = require('os');
const fs = require('fs');
const {
    Client,
    GatewayIntentBits,
    Collection,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    ChannelType,
    PermissionsBitField,
    ButtonStyle,
    ChannelSelectMenuBuilder,
    RoleSelectMenuBuilder,
    MessageFlags,
    ActivityType
} = require('discord.js');
const { createClient } = require('@supabase/supabase-js');
// Importa os módulos
const divulgar = require('./divulgar.js');
const pay = require('./pay.js');
const rank = require('./rank.js');
const noti = require('./noti.js');
// --- CONFIGURAÇÃO DO CLIENTE ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
if (!supabaseUrl || !supabaseKey) {
    console.error('ERRO: Defina SUPABASE_URL e SUPABASE_KEY no .env');
    process.exit(1);
}
const supabase = createClient(supabaseUrl, supabaseKey);
client.commands = new Collection();
client.cooldowns = new Collection();
const BUMP_COOLDOWN_HOURS = 1;
const GLOBAL_COOLDOWN_SECONDS = 10;
const SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
// Cache simples em memória para profiles (discord_user_id -> profile_id)
const userCache = new Map();
// ======================================================
// 1. SISTEMA DE SINCRONIZAÇÃO
// ======================================================
async function syncSingleGuild(guild) {
    try {
        console.log(`📥 Sincronizando servidor: ${guild.name} (${guild.id})`);
   
        const { data: existingData } = await supabase
            .from('bot_guilds')
            .select('invite_link')
            .eq('guild_id', guild.id)
            .single();
        let inviteUrl = existingData?.invite_link;
        if (!inviteUrl) {
            const channel = guild.systemChannel || guild.channels.cache.find(c =>
                c.type === ChannelType.GuildText &&
                guild.members.me.permissionsIn(c).has(PermissionsBitField.Flags.CreateInstantInvite)
            );
            if (channel) {
                try {
                    const invite = await channel.createInvite({
                        maxAge: 0,
                        maxUses: 0,
                        unique: true,
                        reason: 'Sync Bot Site'
                    });
                    inviteUrl = invite.url;
                } catch (e) {
                    console.log(`⚠️ Sem permissão de convite em: ${guild.name}`);
                }
            }
        }
        await supabase.from('bot_guilds').upsert({
            guild_id: guild.id,
            name: guild.name,
            icon_url: guild.iconURL(),
            invite_link: inviteUrl,
        }, { onConflict: 'guild_id' });
    } catch (error) {
        console.error(`Erro ao sincronizar guild ${guild.id}:`, error.message);
    }
}
async function syncAllGuilds() {
    console.log('🔄 Executando verificação de rotina (24h)...');
    for (const [id, guild] of client.guilds.cache) {
        await syncSingleGuild(guild);
    }
    console.log('✅ Verificação de rotina concluída.');
}
async function cleanOldNotificationsSilent() {
    try {
        const twoDaysAgo = new Date();
        twoDaysAgo.setDate(twoDaysAgo.getDate() - 1);
        await supabase.from('notified_bumps').delete().lt('notified_at', twoDaysAgo.toISOString());
    } catch (e) { console.error('Erro limpeza auto:', e); }
}
async function checkInviteLinks() {
    console.log('🔗 Verificando links de convite...');
    const { data: servers, error } = await supabase.from('servers').select('id, invite');
    if (error || !servers) return console.error('Erro ao fetch servers');
    for (const server of servers) {
        if (!server.invite) continue;
        try {
            const invite = await client.fetchInvite(server.invite);
            let valid = true;
            if (invite.expiresAt && invite.expiresAt < new Date()) valid = false;
            await supabase.from('servers').update({ link_valid: valid }).eq('id', server.id);
        } catch (e) {
            await supabase.from('servers').update({ link_valid: false }).eq('id', server.id);
        }
    }
    console.log('✅ Verificação de links concluída.');
}
// ======================================================
// 2. INICIALIZAÇÃO
// ======================================================
client.on('ready', () => {
    console.log(`🤖 Bot online como ${client.user.tag}!`);
    updatePresence();
    client.application.commands.set([
        { name: 'vincular', description: '➕ Vincula sua conta do Discord ao perfil do site.', options: [{ name: 'email', type: 3, description: 'Seu email cadastrado no site.', required: true }] },
        { name: 'bump', description: '⬆️ Impulsiona seu servidor.' },
        { name: 'painel', description: '🔥 Gerencia a divulgação automática do seu servidor.' },
        { name: 'painel-dono', description: '👑 Painel de configuração para o dono.' }
    ]);
    syncAllGuilds();
    setInterval(syncAllGuilds, SYNC_INTERVAL_MS);
    cleanOldNotificationsSilent();
    setInterval(cleanOldNotificationsSilent, 12 * 60 * 60 * 1000);
    divulgar.startDivulgarLoop(client, supabase);
    checkInviteLinks();
    setInterval(checkInviteLinks, 12 * 60 * 60 * 1000);
    // ✅ CORRIGIDO: agora passa apenas o client (sem supabase)
    pay.startPaymentChecker(client);
    rank.initRank(client, supabase);
    // Notificações de servidores (pending → approved/rejected)
    noti.startNotiLoop(client, supabase);
});
client.on('guildCreate', async (guild) => {
    console.log(`➕ Bot adicionado em novo servidor: ${guild.name}`);
    await syncSingleGuild(guild);
    updatePresence();
});
client.on('guildDelete', async (guild) => {
    console.log(`➖ Bot removido do servidor: ${guild.name}`);
    updatePresence();
});
function updatePresence() {
    client.user.setPresence({
        activities: [{ name: `Divulgando ${client.guilds.cache.size} Servidores!`, type: ActivityType.Playing }],
        status: 'online'
    });
}
// ======================================================
// 3. COMANDO DE ADMIN (!co2)
// ======================================================
client.on('messageCreate', async message => {
    if (message.author.id !== '1027205251700363385') return;
    if (message.content === '!co2') {
        const embed = new EmbedBuilder()
            .setTitle('🛠️ Painel de Controle - Admin')
            .setColor('Red')
            .addFields(
                { name: '🏓 Ping (Bot)', value: `${Math.round(client.ws.ping)}ms`, inline: true },
                { name: '📡 API Latency', value: `${Date.now() - message.createdTimestamp}ms`, inline: true },
                { name: '🌐 Servidores', value: `${client.guilds.cache.size}`, inline: true }
            )
            .setTimestamp();
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('admin_refresh_info').setLabel('Atualizar').setStyle(ButtonStyle.Success).setEmoji('🔄'),
            new ButtonBuilder().setCustomId('admin_list_servers').setLabel('Ver Servidores').setStyle(ButtonStyle.Primary).setEmoji('📜'),
            new ButtonBuilder().setCustomId('admin_clean_db').setLabel('Limpar DB (2d)').setStyle(ButtonStyle.Danger).setEmoji('🗑️'),
            new ButtonBuilder().setCustomId('admin_check_links').setLabel('Verificar Links').setStyle(ButtonStyle.Secondary).setEmoji('🔗')
        );
        await message.reply({ embeds: [embed], components: [row] });
    } else if (message.content === '!rank') {
        return rank.handleRankMessage(message, supabase, client);
    }
});
// ======================================================
// 4. INTERAÇÃO GLOBAL
// ======================================================
client.on('interactionCreate', async interaction => {
    // --- BOTÕES DO ADMIN (!co2) ---
    if (interaction.isButton() && interaction.customId.startsWith('admin_')) {
        if (interaction.user.id !== '1027205251700363385') {
            return interaction.reply({ content: '🚫 Você não tem permissão.', flags: [MessageFlags.Ephemeral] });
        }
        if (interaction.customId === 'admin_refresh_info') {
            const newEmbed = new EmbedBuilder()
                .setTitle('🛠️ Painel de Controle - Admin (Atualizado)')
                .setColor('Green')
                .addFields(
                    { name: '🏓 Ping (Bot)', value: `${Math.round(client.ws.ping)}ms`, inline: true },
                    { name: '🌐 Servidores', value: `${client.guilds.cache.size}`, inline: true }
                ).setTimestamp();
            await interaction.update({ embeds: [newEmbed] });
        }
        if (interaction.customId === 'admin_list_servers') {
            const serverList = client.guilds.cache.map(g => `• ${g.name} | ID: ${g.id} | Membros: ${g.memberCount}`).join('\n');
            if (serverList.length > 1900) {
                 const buffer = Buffer.from(serverList, 'utf-8');
                 return interaction.reply({ content: '📂 Lista muito grande:', files: [{ attachment: buffer, name: 'servidores.txt' }], flags: [MessageFlags.Ephemeral] });
            }
            await interaction.reply({ content: `\`\`\`\n${serverList}\n\`\`\``, flags: [MessageFlags.Ephemeral] });
        }
        if (interaction.customId === 'admin_clean_db') {
            await interaction.update({ content: '⏳ **Iniciando limpeza...**', embeds: [], components: [] });
            try {
                const twoDaysAgo = new Date();
                twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
                const { error, count } = await supabase.from('notified_bumps').delete().lt('notified_at', twoDaysAgo.toISOString());
                if (error) await interaction.editReply({ content: `❌ **Erro:** ${error.message}` });
                else await interaction.editReply({ content: `✅ **Limpeza Concluída!** Registros apagados: **${count || 0}**` });
            } catch (err) {
                await interaction.editReply({ content: `❌ Erro crítico: ${err.message}` });
            }
        }
        if (interaction.customId === 'admin_check_links') {
            await interaction.update({ content: '⏳ Verificando links...', embeds: [], components: [] });
            await checkInviteLinks();
            await interaction.editReply({ content: '✅ Verificação de links concluída!' });
        }
        return;
    }
    // --- COOLDOWN GLOBAL ---
    if (interaction.isChatInputCommand()) {
        const now = Date.now();
        const userId = interaction.user.id;
        const lastCommandTime = client.cooldowns.get(userId);
        if (lastCommandTime && (now - lastCommandTime < GLOBAL_COOLDOWN_SECONDS * 500)) {
            const remaining = Math.ceil((GLOBAL_COOLDOWN_SECONDS * 500 - (now - lastCommandTime)) / 500);
            return interaction.reply({ content: `⏳ Aguarde ${remaining}s.`, flags: [MessageFlags.Ephemeral] });
        }
        client.cooldowns.set(userId, now);
    }
    // --- COMANDO /divulgar ---
    if (interaction.isChatInputCommand() && interaction.commandName === 'painel') {
        let profileId;
        if (userCache.has(interaction.user.id)) {
            profileId = userCache.get(interaction.user.id);
        } else {
            const { data: profile } = await supabase.from('profiles').select('id').eq('discord_user_id', interaction.user.id).single();
            if (profile) {
                userCache.set(interaction.user.id, profile.id);
                profileId = profile.id;
            } else {
                profileId = null;
            }
        }
        if (!profileId) {
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
            const embed = new EmbedBuilder()
                .setTitle('Conta Não Encontrada')
                .setDescription('Ops! Não encontramos sua conta em nossa base de dados. Para resolver isso, use o comando /vincular e informe o email usado no login do nosso site. Caso ainda não tenha feito login, clique no botão abaixo para acessar o site.')
                .setColor('Red');
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setLabel('Fazer Login')
                    .setStyle(ButtonStyle.Link)
                    .setURL('https://cordyx.online/#/login')
            );
            return interaction.editReply({ embeds: [embed], components: [row] });
        }
        const { data: servers } = await supabase.from('servers').select('id').eq('user_id', profileId).eq('status', 'approved');
        if (!servers || servers.length === 0) {
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
            const embed = new EmbedBuilder()
                .setTitle('Nenhum Servidor Encontrado')
                .setDescription('Notamos que você ainda não tem nenhum servidor criado. Escolha uma das opções abaixo para adicionar seu servidor ao nosso ecossistema!')
                .setColor('Blue');
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('add_by_bot').setLabel('Adicionar pelo Bot').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('add_by_site').setLabel('Adicionar pelo Site').setStyle(ButtonStyle.Secondary)
            );
            return interaction.editReply({ embeds: [embed], components: [row] });
        }
        return divulgar.handleDivulgar(interaction, supabase);
    }
    // --- INTERAÇÕES DO PAINEL DE DIVULGAÇÃO ---
    if (interaction.isButton()) {
        const id = interaction.customId;
        if (id.startsWith('toggle_divu_')) return divulgar.handleToggleDivu(interaction, supabase);
        if (id.startsWith('update_info_')) return divulgar.handleUpdateInfo(interaction, supabase);
        if (id.startsWith('config_divu_')) return divulgar.handleConfigDivu(interaction, supabase);
        if (id.startsWith('div_menu_config_')) return divulgar.handleConfigMenuButton(interaction, supabase, client, os);
        if (id.startsWith('cfg_set_div_')) return divulgar.handleSetDivChannelBtn(interaction, supabase, client, os);
        if (id.startsWith('cfg_set_log_')) return divulgar.handleSetLogChannelBtn(interaction, supabase, client, os);
        if (id.startsWith('div_toggle_')) return divulgar.handleToggleButton(interaction, supabase, client, os);
        if (id.startsWith('div_metrics_')) return divulgar.handleMetricsButton(interaction, supabase, client, os);
        if (id.startsWith('div_back_')) return divulgar.handleDivBack(interaction, supabase, client, os);
    }
    // --- SELECT DE CANAL ---
    if (interaction.isChannelSelectMenu()) {
        const id = interaction.customId;
        if (id.startsWith('select_div_channel_')) {
            return divulgar.handleSelectDivChannel(interaction, supabase);
        }
        if (id.startsWith('save_div_channel_')) return divulgar.handleSaveDivChannel(interaction, supabase, client, os);
        if (id.startsWith('save_log_channel_')) return divulgar.handleSaveLogChannel(interaction, supabase, client, os);
    }
    // --- SELECT DE SERVIDOR (bump) ---
    if (interaction.isStringSelectMenu()) {
        if (interaction.customId === 'select_server_divulgar') {
            return divulgar.handleSelectServerDivulgar(interaction, supabase, client, os);
        }
    }
    // --- COMANDO PAINEL-DONO ---
    if (interaction.isChatInputCommand() && interaction.commandName === 'painel-dono') {
        if (interaction.user.id !== '1027205251700363385') {
            return interaction.reply({ content: '🚫 Acesso negado.', flags: [MessageFlags.Ephemeral] });
        }
        // ✅ CORRIGIDO: agora passa apenas o client
        return pay.handlePainelDono(interaction, client);
    }
    // --- INTERAÇÕES PAY ---
    if (interaction.customId && interaction.customId.startsWith('pay|')) {
        // ✅ CORRIGIDO: agora passa apenas o client
        return pay.handleInteraction(interaction, client);
    }
    if (interaction.isButton() && interaction.customId === 'update_rank') {
        return rank.handleUpdate(interaction, supabase, client);
    }
    // --- INTERAÇÕES DE NOTIFICAÇÃO DE SERVIDORES (approve/reject) ---
    if (interaction.customId &&
        (interaction.customId.startsWith('approve_server_') ||
         interaction.customId.startsWith('reject_server_'))) {
        return noti.handleApproval(interaction, supabase, client);
    }
    // --- COMANDOS SLASH (link, unlink, bump) ---
    if (interaction.isChatInputCommand()) {
        const { commandName } = interaction;
   
        if (commandName === 'vincular') {
            const email = interaction.options.getString('email');
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
            try {
                const { data: profileData, error: profileError } = await supabase
                    .from('profiles').select('id, discord_user_id').eq('email', email).single();
                if (profileError || !profileData) {
                    const embed = new EmbedBuilder()
                        .setTitle('Conta Não Encontrada')
                        .setDescription('Ops! Não encontramos sua conta em nossa base de dados. Faça o login no nosso site primeiro e volte aqui para vincular.')
                        .setColor('Red');
                    const row = new ActionRowBuilder().addComponents(
                        new ButtonBuilder()
                            .setLabel('Fazer Login no Site')
                            .setStyle(ButtonStyle.Link)
                            .setURL('https://cordyx.online')
                    );
                    return interaction.editReply({ embeds: [embed], components: [row] });
                }
                if (profileData.discord_user_id === interaction.user.id) return interaction.editReply({ content: '✅ **Já vinculado!**' });
                else if (profileData.discord_user_id) return interaction.editReply({ content: '⚠️ **Conta pertence a outro usuário.**' });
           
                await supabase.from('profiles').update({ discord_user_id: null }).eq('discord_user_id', interaction.user.id);
                userCache.delete(interaction.user.id); // Atualiza cache: remove vínculo antigo, se existir
                const { error: updateError } = await supabase
                    .from('profiles').update({ discord_user_id: interaction.user.id }).eq('id', profileData.id);
                if (updateError) return interaction.editReply({ content: '❌ Erro ao salvar.' });
                userCache.set(interaction.user.id, profileData.id); // Atualiza cache com novo vínculo
                await interaction.editReply({ embeds: [new EmbedBuilder().setTitle('✅ Conta Vinculada!').setColor('Green')] });
            } catch (error) { console.error(error); await interaction.editReply({ content: '❌ Erro inesperado.' }); }
        }
   
        else if (commandName === 'bump') {
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
            try {
                let profileId;
                if (userCache.has(interaction.user.id)) {
                    profileId = userCache.get(interaction.user.id);
                } else {
                    const { data: profile } = await supabase.from('profiles').select('id').eq('discord_user_id', interaction.user.id).single();
                    if (profile) {
                        userCache.set(interaction.user.id, profile.id);
                        profileId = profile.id;
                    } else {
                        profileId = null;
                    }
                }
                if (!profileId) {
                    const embed = new EmbedBuilder()
                        .setTitle('Conta Não Encontrada')
                        .setDescription('Ops! Não encontramos sua conta em nossa base de dados. Para resolver isso, use o comando /vincular e informe o email usado no login do nosso site. Caso ainda não tenha feito login, clique no botão abaixo para acessar o site.')
                        .setColor('Red');
                    const row = new ActionRowBuilder().addComponents(
                        new ButtonBuilder()
                            .setLabel('Fazer Login')
                            .setStyle(ButtonStyle.Link)
                            .setURL('https://cordyx.online/#/login')
                    );
                    return interaction.editReply({ embeds: [embed], components: [row] });
                }
                const { data: servers } = await supabase.from('servers').select('id, name, last_bump').eq('user_id', profileId).eq('status', 'approved');
                if (!servers || servers.length === 0) {
                    const embed = new EmbedBuilder()
                        .setTitle('Nenhum Servidor Encontrado')
                        .setDescription('Notamos que você ainda não tem nenhum servidor criado. Escolha uma das opções abaixo para adicionar seu servidor ao nosso ecossistema!')
                        .setColor('Blue');
                    const row = new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId('add_by_bot').setLabel('Adicionar pelo Bot').setStyle(ButtonStyle.Primary),
                        new ButtonBuilder().setCustomId('add_by_site').setLabel('Adicionar pelo Site').setStyle(ButtonStyle.Secondary)
                    );
                    return interaction.editReply({ embeds: [embed], components: [row] });
                }
           
                const options = servers.map(server =>
                    new StringSelectMenuOptionBuilder()
                        .setLabel(server.name).setValue(server.id)
                        .setDescription(`Último: ${server.last_bump ? new Date(server.last_bump).toLocaleString('pt-BR') : 'Nunca'}`)
                ).slice(0, 25);
           
                const row = new ActionRowBuilder().addComponents(
                    new StringSelectMenuBuilder().setCustomId('select_server_to_bump').setPlaceholder('Escolha o servidor...').addOptions(options)
                );
                await interaction.editReply({ content: '🚀 **Selecione:**', components: [row] });
            } catch (err) { console.error(err); await interaction.editReply({ content: '❌ Erro interno.' }); }
        }
    }
    // --- AÇÃO DE BUMP ---
    if (interaction.isStringSelectMenu() || interaction.isButton()) {
        if (interaction.customId === 'select_server_to_bump' || interaction.customId.startsWith('dm_bump_server_')) {
            if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
       
            const serverId = interaction.isStringSelectMenu() ? interaction.values[0] : interaction.customId.split('_')[3];
            const { data: server, error } = await supabase.from('servers').select('*').eq('id', serverId).single();
            if (error || !server) return interaction.editReply({ content: '❌ Servidor não encontrado.' });
       
            const lastBump = server.last_bump ? new Date(server.last_bump) : new Date(0);
            const now = new Date();
            const diffHours = (now - lastBump) / (1000 * 60 * 60);
       
            if (diffHours < BUMP_COOLDOWN_HOURS) {
                const minutes = Math.ceil((BUMP_COOLDOWN_HOURS - diffHours) * 60);
                return interaction.editReply({ content: `⏳ **${server.name}** cooldown: ${minutes} min.` });
            }
       
            await supabase.from('servers').update({ last_bump: now.toISOString(), bump_count: (server.bump_count || 0) + 1 }).eq('id', serverId);
            await supabase.from('server_bumps').insert([{ server_id: serverId, user_id: server.user_id, bump_time: now.toISOString() }]);
            return interaction.editReply({ content: `✅ **${server.name}** bumpado! 🚀` });
        }
    }
    // --- BOTÕES ADICIONAR SERVIDOR ---
    if (interaction.isButton()) {
        if (interaction.customId === 'add_by_bot') {
            const embed = new EmbedBuilder()
                .setTitle('Em Desenvolvimento')
                .setDescription('Esse sistema ainda está em desenvolvimento! Por favor, utilize a opção "Adicionar pelo Site".')
                .setColor('Yellow');
            await interaction.reply({ embeds: [embed], ephemeral: true });
        } else if (interaction.customId === 'add_by_site') {
            const embed = new EmbedBuilder()
                .setTitle('Adicionar Servidor pelo Site')
                .setDescription('Para adicionar seu servidor ao nosso site, clique no botão abaixo para acessar o site e fazer login (caso ainda não tenha feito). Você será redirecionado automaticamente para a dashboard. Lá, preencha as informações do servidor e clique em "Adicionar Servidor". Pronto! Agora é só aguardar a aprovação.')
                .setColor('Green');
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setLabel('Acessar o Site')
                    .setStyle(ButtonStyle.Link)
                    .setURL('https://cordyx.online/#/login')
            );
            await interaction.update({ embeds: [embed], components: [row] });
        }
    }
});
// ======================================================
// 5. LOOP DE NOTIFICAÇÕES
// ======================================================
setInterval(async () => {
    try {
        const { data: profiles } = await supabase
            .from('profiles').select('discord_user_id, servers(id, name, last_bump, plan_type, status)')
            .not('discord_user_id', 'is', null);
        if (!profiles) return;
   
        const now = new Date();
        for (const profile of profiles) {
            if (!profile.servers) continue;
            const user = await client.users.fetch(profile.discord_user_id).catch(() => null);
            if (!user) continue;
       
            for (const server of profile.servers) {
                if (server.plan_type !== 'free' || server.status !== 'approved') continue;
                const lastBump = server.last_bump ? new Date(server.last_bump) : new Date(0);
                const diffHours = (now - lastBump) / (1000 * 60 * 60);
           
                if (diffHours >= BUMP_COOLDOWN_HOURS) {
                    const { data: notified } = await supabase
                        .from('notified_bumps').select('id').eq('server_id', server.id)
                        .gte('notified_at', new Date(now - 3 * 60 * 60 * 1000).toISOString());
                   
                    if (!notified || notified.length === 0) {
                        try {
                            const row = new ActionRowBuilder().addComponents(
                                new ButtonBuilder().setCustomId(`dm_bump_server_${server.id}`).setLabel('🚀 Bump Agora').setStyle(ButtonStyle.Primary)
                            );
                            await user.send({ content: `🔔 **${server.name}** já pode ser impulsionado!`, components: [row] });
                            await supabase.from('notified_bumps').insert([{ server_id: server.id, notified_at: now.toISOString() }]);
                        } catch (e) { /* DM Fechada */ }
                    }
                }
            }
        }
    } catch (e) { console.error('Erro Notificacao:', e); }
}, 15 * 60 * 1000);
client.login(process.env.DISCORD_TOKEN);
// Tratamento global para erros não tratados
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});