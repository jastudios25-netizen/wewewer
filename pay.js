const crypto = require('crypto');
const fs = require('fs');
const {
    EmbedBuilder, ActionRowBuilder, ButtonBuilder,
    StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
    ChannelType, ButtonStyle, ChannelSelectMenuBuilder,
    RoleSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
    MessageFlags, PermissionsBitField
} = require('discord.js');

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────
const API_BASE = 'https://carteira.nevermissapps.com/v1';
const API_KEY = 'NM_1af01518fe52f8f584b7dd5152ffc882462770a9240eaf10';
const CONFIG_FILE = './pay_config.json';
const OWNER_ID = '1027205251700363385';

let localConfig = {};
try {
    if (fs.existsSync(CONFIG_FILE))
        localConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
} catch (e) { console.error('[pay_config] Erro ao carregar:', e.message); }

if (!localConfig.pay_plans) localConfig.pay_plans = [];
if (!localConfig.pay_orders) localConfig.pay_orders = [];
if (!localConfig.next_plan_id) localConfig.next_plan_id = 1;
if (!localConfig.next_order_id) localConfig.next_order_id = 1;

function cfg(key) { return localConfig[key] ?? null; }
function setCfg(key, val) {
    localConfig[key] = val;
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(localConfig, null, 2));
}

const buildId = (...parts) => parts.join('|');
const parseId = (id) => {
    const p = id.split('|');
    return { action: p[1], p: p.slice(2) };
};

const BRL = (v) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);

function countKeys(planId) {
    const plan = localConfig.pay_plans.find(p => String(p.id) === String(planId));
    if (!plan || !Array.isArray(plan.keys)) return 0;
    return plan.keys.filter(k => !k.used).length;
}

function consumeKey(planId, discordUserId) {
    const plan = localConfig.pay_plans.find(p => String(p.id) === String(planId));
    if (!plan || !Array.isArray(plan.keys)) return null;
    const keyRow = plan.keys.find(k => !k.used);
    if (!keyRow) return null;
    keyRow.used = true;
    keyRow.used_by = discordUserId;
    keyRow.used_at = new Date().toISOString();
    setCfg('pay_plans', localConfig.pay_plans);
    return keyRow;
}

function syncStock(planId) {
    const stock = countKeys(planId);
    const idx = localConfig.pay_plans.findIndex(p => String(p.id) === String(planId));
    if (idx !== -1) {
        localConfig.pay_plans[idx].stock = stock;
        setCfg('pay_plans', localConfig.pay_plans);
    }
    return stock;
}

async function updatePanel(client) {
    const channelId = cfg('pay_panel_channel');
    const messageId = cfg('pay_panel_message_id');
    if (!channelId || !messageId) return;
    const channel = client.channels?.cache?.get(channelId);
    if (!channel || channel.type !== ChannelType.GuildText) return;
    const message = await channel.messages.fetch(messageId).catch(() => null);
    if (!message) return;

    const components = [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(buildId('pay', 'open_cart')).setLabel('Comprar').setStyle(ButtonStyle.Primary)
    )];
    await message.edit({ components }).catch(e => console.error('Erro ao atualizar painel:', e));
}

async function activatePlan(order, client, thread = null) {
    const plan = localConfig.pay_plans.find(p => String(p.id) === String(order.plan_id));
    if (!plan) return;

    const keyRow = consumeKey(order.plan_id, order.user_discord_id);
    syncStock(order.plan_id);
    await updatePanel(client);

    const embed = new EmbedBuilder()
        .setTitle('🎉 Compra Aprovada!')
        .setDescription(`Você comprou **${plan.label}**!`)
        .addFields(
            { name: '📋 Código', value: `\`\`\`${keyRow?.key ?? 'Sem chave'}\`\`\``, inline: false },
            { name: '⏱️ Duração', value: `${keyRow?.days ?? plan.days} dias`, inline: true },
            { name: '📦 Plano', value: plan.label, inline: true }
        )
        .setColor('Gold')
        .setFooter({ text: '💡 Para ativar, acesse o site e insira o código na área Premium!' })
        .setTimestamp();

    let sent = false;
    try {
        const user = await client.users.fetch(order.user_discord_id);
        if (keyRow) {
            await user.send({ embeds: [embed] });
            sent = true;
        } else {
            await user.send(`⚠️ **Pagamento aprovado**, mas não há chaves disponíveis no estoque!\nEntre em contato com o suporte.`);
        }
    } catch (e) { sent = false; }

    // Logs
    const pubCh = client.channels?.cache?.get(cfg('pay_public_log_channel'));
    if (pubCh?.isTextBased()) {
        await pubCh.send({ embeds: [new EmbedBuilder().setTitle('🎉 Nova Venda!').setDescription(`<@${order.user_discord_id}> comprou **${plan.label}**`).setColor('Green').setTimestamp()] });
    }

    const privCh = client.channels?.cache?.get(cfg('pay_private_log_channel'));
    if (privCh?.isTextBased()) {
        await privCh.send({ embeds: [new EmbedBuilder().setTitle('🔒 Compra Aprovada')
            .addFields(
                { name: 'ID Ordem', value: String(order.id), inline: true },
                { name: 'Usuário', value: `<@${order.user_discord_id}>`, inline: true },
                { name: 'Plano', value: plan.label, inline: true },
                { name: 'Key', value: keyRow ? `\`${keyRow.key}\`` : '❌ Sem estoque', inline: false }
            )
            .setColor('Purple').setTimestamp()
        ]});
    }

    if (thread) {
        const successEmbed = new EmbedBuilder().setTitle('🎉 Pagamento Aprovado!').setDescription('O produto foi enviado com sucesso. Este tópico será fechado em 10 minutos.').setColor('Green').setTimestamp();
        const successMessage = await thread.send({ embeds: [successEmbed] });

        if (!sent && keyRow) {
            const errorEmbed = new EmbedBuilder().setTitle('⚠️ DM Bloqueada').setDescription('Não consegui enviar a chave por DM. Abra suas DMs e clique em "Reenviar para DM" ou "Enviar no Tópico".').setColor('Red');
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(buildId('pay','resend_dm', order.id)).setLabel('Reenviar para DM').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId(buildId('pay','send_thread', order.id)).setLabel('Enviar no Tópico').setStyle(ButtonStyle.Secondary)
            );
            await thread.send({ embeds: [errorEmbed], components: [row] });
        } else {
            const messages = await thread.messages.fetch({ limit: 100 });
            for (const msg of messages.values()) {
                if (msg.author.id === client.user.id && msg.id !== successMessage.id) await msg.delete().catch(() => {});
            }
        }
        setTimeout(() => thread.delete().catch(() => {}), 10 * 60 * 1000);
    }
}

// ====================== PAINEL DONO ======================
async function handlePainelDono(interaction, client) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await _renderOwnerPanel(interaction, client);
}

async function _renderOwnerPanel(interaction, client) {
    const thumbnail = cfg('pay_panel_thumbnail') || client.user?.displayAvatarURL();
    const embed = new EmbedBuilder()
        .setTitle('🛡️ Painel Dono — Sistema de Pagamentos')
        .setDescription('Configure canais, cargos, planos, chaves e textos.')
        .setColor('Purple')
        .setThumbnail(thumbnail)
        .addFields(
            { name: '📋 Canal Painel', value: cfg('pay_panel_channel') ? `<#${cfg('pay_panel_channel')}>` : '❌ Não configurado', inline: true },
            { name: '📢 Log Público', value: cfg('pay_public_log_channel') ? `<#${cfg('pay_public_log_channel')}>` : '❌ Não configurado', inline: true },
            { name: '🔒 Log Privado', value: cfg('pay_private_log_channel') ? `<#${cfg('pay_private_log_channel')}>` : '❌ Não configurado', inline: true },
            { name: '✅ Cargo Aprovar', value: cfg('pay_approve_role') ? `<@&${cfg('pay_approve_role')}>` : '❌ Não configurado', inline: true }
        )
        .setFooter({ text: `Dono: ${OWNER_ID}` })
        .setTimestamp();

    const r1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(buildId('pay','setc','panel_channel')).setLabel('📋 Canal Painel').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(buildId('pay','setc','public_log')).setLabel('📢 Log Público').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(buildId('pay','setc','private_log')).setLabel('🔒 Log Privado').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(buildId('pay','setc','approve_role')).setLabel('✅ Cargo Aprovar').setStyle(ButtonStyle.Secondary)
    );
    const r2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(buildId('pay','paneltext')).setLabel('✏️ Editar Texto').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(buildId('pay','postpanel')).setLabel('🚀 Postar Painel').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(buildId('pay','syncplans')).setLabel('🔄 Sync Estoque').setStyle(ButtonStyle.Secondary)
    );
    const r3 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(buildId('pay','addplan')).setLabel('➕ Novo Plano').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(buildId('pay','listplans')).setLabel('📜 Listar / Editar Planos').setStyle(ButtonStyle.Secondary)
    );

    await interaction.editReply({ embeds: [embed], components: [r1, r2, r3] });
}

// ====================== HANDLER PRINCIPAL ======================
async function handleInteraction(interaction, client) {
    if (!interaction.customId?.startsWith('pay|')) return;

    const { action, p } = parseId(interaction.customId);
    const isOwner = interaction.user.id === OWNER_ID;

    const OWNER_ONLY = ['setc','saveconfig','paneltext','postpanel','syncplans','addplan','listplans','editplan','addkeys','viewkeys'];
    const OPENS_MODAL = ['paneltext','addplan','editplan','addkeys'];

    if (OWNER_ONLY.includes(action) && !isOwner)
        return interaction.reply({ content: '🚫 Acesso negado.', flags: MessageFlags.Ephemeral });

    // DEFER APENAS UMA VEZ
    try {
        if (interaction.isModalSubmit()) {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        } else if (action === 'open_cart') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        } else if (!OPENS_MODAL.includes(action)) {
            if (!interaction.deferred && !interaction.replied) {
                await interaction.deferUpdate();
            }
        }
    } catch (e) {
        console.error(e);
        return;
    }

    switch (action) {
        case 'setc': {
            const type = p[0];
            const labels = { panel_channel: 'canal do painel', public_log: 'log público', private_log: 'log privado' };
            if (type === 'approve_role') {
                await interaction.editReply({
                    content: 'Selecione o cargo que poderá aprovar pagamentos:',
                    components: [new ActionRowBuilder().addComponents(
                        new RoleSelectMenuBuilder().setCustomId(buildId('pay','saveconfig','approve_role')).setPlaceholder('Selecionar cargo...')
                    )]
                });
                return;
            }
            await interaction.editReply({
                content: `Selecione o ${labels[type] ?? type}:`,
                components: [new ActionRowBuilder().addComponents(
                    new ChannelSelectMenuBuilder()
                        .setCustomId(buildId('pay','saveconfig', type))
                        .setPlaceholder(`Selecionar ${labels[type] ?? type}...`)
                        .setChannelTypes([ChannelType.GuildText])
                )]
            });
            return;
        }

        case 'saveconfig': {
            const type = p[0];
            const val = interaction.values[0];
            const map = { panel_channel: 'pay_panel_channel', public_log: 'pay_public_log_channel', private_log: 'pay_private_log_channel', approve_role: 'pay_approve_role' };
            if (map[type]) setCfg(map[type], val);
            const mention = type === 'approve_role' ? `<@&${val}>` : `<#${val}>`;
            await interaction.editReply({ content: `✅ Salvo: ${mention}`, components: [] });
            return;
        }

        case 'paneltext': {
            await interaction.showModal(
                new ModalBuilder().setCustomId(buildId('pay','modal','paneltext'))
                    .setTitle('Configurar Texto do Painel')
                    .addComponents(
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('title').setLabel('Título').setStyle(TextInputStyle.Short).setValue(cfg('pay_panel_title') ?? '🛒 Comprar Premium').setRequired(true)),
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('desc').setLabel('Descrição').setStyle(TextInputStyle.Paragraph).setValue(cfg('pay_panel_desc') ?? 'Clique em Comprar').setRequired(true)),
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('color').setLabel('Cor Hex').setStyle(TextInputStyle.Short).setValue(cfg('pay_panel_color') ?? '#FFD700')),
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('footer').setLabel('Rodapé').setStyle(TextInputStyle.Short).setValue(cfg('pay_panel_footer') ?? '')),
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('thumbnail').setLabel('URL Thumbnail').setStyle(TextInputStyle.Short).setValue(cfg('pay_panel_thumbnail') ?? ''))
                    )
            );
            return;
        }

        case 'postpanel': {
            const channelId = cfg('pay_panel_channel');
            if (!channelId) return interaction.editReply({ content: '⚠️ Configure o canal primeiro.' });
            let channel = interaction.client.channels.cache.get(channelId) || await interaction.client.channels.fetch(channelId).catch(() => null);
            if (!channel || channel.type !== ChannelType.GuildText) return interaction.editReply({ content: '⚠️ Canal inválido.' });

            const embed = new EmbedBuilder()
                .setTitle(cfg('pay_panel_title') ?? '🛒 Comprar Premium')
                .setDescription(cfg('pay_panel_desc') ?? 'Clique em Comprar')
                .setColor(cfg('pay_panel_color') ?? 'Gold')
                .setTimestamp();
            if (cfg('pay_panel_footer')) embed.setFooter({ text: cfg('pay_panel_footer') });
            if (cfg('pay_panel_thumbnail')) embed.setThumbnail(cfg('pay_panel_thumbnail'));

            const sent = await channel.send({
                embeds: [embed],
                components: [new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(buildId('pay','open_cart')).setLabel('Comprar').setStyle(ButtonStyle.Primary)
                )]
            });
            setCfg('pay_panel_message_id', sent.id);
            return interaction.editReply({ content: '✅ Painel postado com sucesso!' });
        }

        case 'syncplans': {
            const plans = cfg('pay_plans') || [];
            if (!plans.length) return interaction.editReply({ content: '⚠️ Nenhum plano cadastrado.' });
            const lines = plans.map(p => `**${p.label}**: ${countKeys(p.id)} keys`);
            return interaction.editReply({ embeds: [new EmbedBuilder().setTitle('🔄 Estoque Sincronizado').setDescription(lines.join('\n')).setColor('Blue')] });
        }

        case 'addplan': {
            return interaction.showModal(
                new ModalBuilder().setCustomId(buildId('pay','modal','addplan'))
                    .setTitle('Criar Novo Plano')
                    .addComponents(
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('label').setLabel('Nome do Plano').setStyle(TextInputStyle.Short).setRequired(true)),
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('days').setLabel('Duração (dias)').setStyle(TextInputStyle.Short).setRequired(true)),
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('price').setLabel('Preço R$').setStyle(TextInputStyle.Short).setRequired(true)),
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('desc').setLabel('Descrição').setStyle(TextInputStyle.Paragraph).setRequired(true))
                    )
            );
        }

        case 'listplans': {
            const plans = cfg('pay_plans') || [];
            if (!plans.length) return interaction.editReply({ content: '⚠️ Nenhum plano cadastrado.' });
            const fields = plans.map(p => ({
                name: `📦 ${p.label}`,
                value: `💰 ${BRL(p.price)} · 📅 ${p.days} dias · 🔑 **${countKeys(p.id)}** keys`,
                inline: false
            }));
            const opts = plans.map(p => new StringSelectMenuOptionBuilder().setLabel(p.label).setValue(String(p.id)).setDescription(`${BRL(p.price)} · ${countKeys(p.id)} keys`));
            return interaction.editReply({
                embeds: [new EmbedBuilder().setTitle('📋 Planos Cadastrados').addFields(fields).setColor('Blue')],
                components: [
                    new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(buildId('pay','editplan')).setPlaceholder('Editar plano...').addOptions(opts)),
                    new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(buildId('pay','addkeys')).setPlaceholder('Adicionar keys...').addOptions(opts)),
                    new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(buildId('pay','viewkeys')).setPlaceholder('Ver keys...').addOptions(opts))
                ]
            });
        }

        case 'editplan': {
            const planId = interaction.values?.[0] ?? p[0];
            const plan = localConfig.pay_plans.find(p => String(p.id) === String(planId));
            if (!plan) return;
            return interaction.showModal(
                new ModalBuilder().setCustomId(buildId('pay','modal','editplan', planId))
                    .setTitle(`Editar ${plan.label}`)
                    .addComponents(
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('label').setLabel('Nome').setStyle(TextInputStyle.Short).setValue(plan.label).setRequired(true)),
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('days').setLabel('Dias').setStyle(TextInputStyle.Short).setValue(String(plan.days)).setRequired(true)),
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('price').setLabel('Preço R$').setStyle(TextInputStyle.Short).setValue(String(plan.price)).setRequired(true)),
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('desc').setLabel('Descrição').setStyle(TextInputStyle.Paragraph).setValue(plan.description ?? '').setRequired(true))
                    )
            );
        }

        case 'addkeys': {
            const planId = interaction.values?.[0] ?? p[0];
            const plan = localConfig.pay_plans.find(p => String(p.id) === String(planId));
            return interaction.showModal(
                new ModalBuilder().setCustomId(buildId('pay','modal','addkeys', planId))
                    .setTitle(`Adicionar Keys — ${plan?.label}`)
                    .addComponents(
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('keys').setLabel('Chaves (uma por linha)').setStyle(TextInputStyle.Paragraph).setRequired(true)),
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('days_override').setLabel('Dias por key (vazio = do plano)').setStyle(TextInputStyle.Short))
                    )
            );
        }

        case 'viewkeys': {
            const planId = interaction.values?.[0] ?? p[0];
            const plan = localConfig.pay_plans.find(p => String(p.id) === String(planId));
            if (!plan) return;
            const avail = countKeys(planId);
            return interaction.editReply({
                embeds: [new EmbedBuilder().setTitle(`🔑 Keys — ${plan.label}`).addFields(
                    { name: '✅ Disponíveis', value: String(avail), inline: true },
                    { name: '🔴 Usadas', value: String((plan.keys?.length || 0) - avail), inline: true },
                    { name: '📦 Total', value: String(plan.keys?.length || 0), inline: true }
                ).setColor('Blue')]
            });
        }

        case 'modal': {
            const sub = p[0];
            const planId = p[1];
            if (sub === 'paneltext') {
                setCfg('pay_panel_title', interaction.fields.getTextInputValue('title'));
                setCfg('pay_panel_desc', interaction.fields.getTextInputValue('desc'));
                setCfg('pay_panel_color', interaction.fields.getTextInputValue('color') || '#FFD700');
                setCfg('pay_panel_footer', interaction.fields.getTextInputValue('footer'));
                setCfg('pay_panel_thumbnail', interaction.fields.getTextInputValue('thumbnail'));
                return interaction.editReply({ content: '✅ Configurações salvas!' });
            }
            if (sub === 'addplan') {
                const label = interaction.fields.getTextInputValue('label');
                const days = parseInt(interaction.fields.getTextInputValue('days'));
                const price = parseFloat(interaction.fields.getTextInputValue('price'));
                const desc = interaction.fields.getTextInputValue('desc');
                if (isNaN(days) || isNaN(price)) return interaction.editReply({ content: '❌ Dias e preço devem ser números.' });
                localConfig.pay_plans.push({ id: localConfig.next_plan_id++, label, days, price, description: desc, stock: 0, keys: [] });
                setCfg('pay_plans', localConfig.pay_plans);
                setCfg('next_plan_id', localConfig.next_plan_id);
                return interaction.editReply({ content: `✅ Plano **${label}** criado!` });
            }
            if (sub === 'editplan') {
                const label = interaction.fields.getTextInputValue('label');
                const days = parseInt(interaction.fields.getTextInputValue('days'));
                const price = parseFloat(interaction.fields.getTextInputValue('price'));
                const desc = interaction.fields.getTextInputValue('desc');
                const idx = localConfig.pay_plans.findIndex(q => String(q.id) === String(planId));
                if (idx === -1) return interaction.editReply({ content: '❌ Plano não encontrado.' });
                localConfig.pay_plans[idx] = { ...localConfig.pay_plans[idx], label, days, price, description: desc };
                setCfg('pay_plans', localConfig.pay_plans);
                return interaction.editReply({ content: `✅ Plano **${label}** editado!` });
            }
            if (sub === 'addkeys') {
                const raw = interaction.fields.getTextInputValue('keys');
                let daysPerKey = parseInt(interaction.fields.getTextInputValue('days_override'));
                const planIdx = localConfig.pay_plans.findIndex(p => String(p.id) === String(planId));
                if (planIdx === -1) return interaction.editReply({ content: '❌ Plano não encontrado.' });
                const plan = localConfig.pay_plans[planIdx];
                if (isNaN(daysPerKey)) daysPerKey = plan.days ?? 30;
                const keys = raw.split('\n').map(k => k.trim().toUpperCase()).filter(k => k.length >= 4);
                if (!keys.length) return interaction.editReply({ content: '❌ Nenhuma chave válida.' });
                plan.keys = plan.keys || [];
                plan.keys.push(...keys.map(k => ({ key: k, days: daysPerKey, used: false })));
                setCfg('pay_plans', localConfig.pay_plans);
                syncStock(planId);
                return interaction.editReply({ content: `✅ **${keys.length}** chaves adicionadas!` });
            }
            break;
        }

        case 'open_cart': {
            const dummy = await interaction.channel.send({ content: '.', flags: MessageFlags.SuppressNotifications });
            const thread = await dummy.startThread({ name: `🛒 Compra — ${interaction.user.username}`, autoArchiveDuration: 60, type: ChannelType.GuildPublicThread });
            await dummy.delete().catch(() => {});
            await thread.members.add(interaction.user.id);

            const approveRole = cfg('pay_approve_role');
            const mention = approveRole ? `<@&${approveRole}>` : '';
            const plans = cfg('pay_plans') || [];
            const available = plans.map(p => ({ ...p, stock: countKeys(p.id) })).filter(p => p.stock > 0);

            const options = available.length ? available.map(p =>
                new StringSelectMenuOptionBuilder().setLabel(p.label).setValue(String(p.id))
                    .setDescription(`${BRL(p.price)} — ${p.days} dias · ${p.stock} em estoque`)
            ) : [new StringSelectMenuOptionBuilder().setLabel('Sem estoque').setValue('none')];

            await thread.send({
                content: `${interaction.user} Bem-vindo! ${mention}`,
                embeds: [new EmbedBuilder().setTitle('🛒 Escolha o Plano').setColor('Blue')],
                components: [
                    new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(buildId('pay','select_plan')).setPlaceholder('Escolha seu plano...').addOptions(options)),
                    new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(buildId('pay','cancelthread','0')).setLabel('❌ Cancelar').setStyle(ButtonStyle.Danger))
                ]
            });
            return interaction.editReply({ content: `✅ Carrinho aberto → <#${thread.id}>` });
        }

        case 'select_plan': {
            const planId = interaction.values[0];
            if (planId === 'none') return interaction.editReply({ content: '❌ Nenhum plano disponível.' });
            const plan = localConfig.pay_plans.find(p => String(p.id) === String(planId));
            if (!plan) return interaction.editReply({ content: '❌ Plano não encontrado.' });
            const stock = countKeys(planId);
            if (stock <= 0) return interaction.editReply({ content: '❌ Estoque esgotado.' });

            const originalContent = interaction.message.content;
            const embed = new EmbedBuilder()
                .setTitle(`🛒 ${plan.label}`)
                .setDescription(plan.description ?? 'Sem descrição.')
                .addFields(
                    { name: '⏱️ Duração', value: `${plan.days} dias`, inline: true },
                    { name: '💰 Preço', value: BRL(plan.price), inline: true },
                    { name: '🔑 Estoque', value: `${stock} disponíveis`, inline: true }
                )
                .setColor('Blue');

            const components = [new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(buildId('pay','confirm', planId)).setLabel('✅ Continuar').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId(buildId('pay','cancelthread','0')).setLabel('❌ Cancelar').setStyle(ButtonStyle.Danger)
            )];

            await interaction.editReply({ content: originalContent, embeds: [embed], components, allowedMentions: { parse: [] } });
            return;
        }

        case 'confirm': {
            const planId = p[0];
            const plan = localConfig.pay_plans.find(p => String(p.id) === String(planId));
            if (!plan) return interaction.editReply({ content: '❌ Plano não encontrado.' });
            if (countKeys(planId) <= 0) return interaction.editReply({ content: '❌ Estoque esgotado.' });

            const newOrder = {
                id: localConfig.next_order_id++,
                user_discord_id: interaction.user.id,
                plan_id: planId,
                status: 'pending',
                created_at: new Date().toISOString(),
                external_reference: crypto.randomUUID()
            };
            localConfig.pay_orders.push(newOrder);
            setCfg('pay_orders', localConfig.pay_orders);
            setCfg('next_order_id', localConfig.next_order_id);

            const originalContent = interaction.message.content;
            const embed = new EmbedBuilder()
                .setTitle('💳 Forma de Pagamento')
                .setDescription(`Comprando **${plan.label}**`)
                .addFields(
                    { name: '💰 Valor', value: BRL(plan.price), inline: true },
                    { name: '⏱️ Duração', value: `${plan.days} dias`, inline: true }
                )
                .setColor('Gold');

            const components = [new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(buildId('pay','paymethod', newOrder.id, 'pix')).setLabel('💠 Pagar com PIX').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId(buildId('pay','cancel', newOrder.id)).setLabel('❌ Cancelar').setStyle(ButtonStyle.Danger)
            )];

            await interaction.editReply({ content: originalContent, embeds: [embed], components, allowedMentions: { parse: [] } });
            return;
        }

        case 'paymethod': {
            const [orderId, method] = p;
            if (method === 'pix') return _generatePix(interaction, client, orderId);
            break;
        }

        case 'approve': {
            const orderId = p[0];
            const approveRole = cfg('pay_approve_role');
            if (!approveRole || !interaction.member.roles.cache.has(approveRole))
                return interaction.editReply({ content: '🚫 Sem permissão.' });

            const orderIdx = localConfig.pay_orders.findIndex(o => String(o.id) === String(orderId) && o.status === 'pending');
            if (orderIdx === -1) return interaction.editReply({ content: '❌ Já processado.' });

            const order = localConfig.pay_orders[orderIdx];
            await activatePlan(order, client, interaction.channel);
            order.status = 'approved';
            setCfg('pay_orders', localConfig.pay_orders);
            break;
        }

        case 'cancel':
        case 'cancelthread': {
            const orderId = p[0];
            if (orderId && orderId !== '0') {
                const idx = localConfig.pay_orders.findIndex(o => String(o.id) === String(orderId));
                if (idx !== -1) {
                    localConfig.pay_orders[idx].status = 'cancelled';
                    setCfg('pay_orders', localConfig.pay_orders);
                }
            }
            await interaction.channel.delete().catch(() => {});
            break;
        }

        case 'resend_dm': {
            const orderId = p[0];
            const order = localConfig.pay_orders.find(o => String(o.id) === String(orderId));
            const plan = localConfig.pay_plans.find(pl => String(pl.id) === String(order?.plan_id));
            const keyRow = plan?.keys.find(k => k.used_by === order?.user_discord_id);
            if (!keyRow) return interaction.editReply({ content: '❌ Key não encontrada.' });

            try {
                const user = await client.users.fetch(order.user_discord_id);
                await user.send({ embeds: [new EmbedBuilder().setTitle('🔑 Sua chave').setDescription(`\`\`\`${keyRow.key}\`\`\``).setColor('Blue')] });
                await interaction.message.delete().catch(() => {});
            } catch (e) {
                await interaction.editReply({ embeds: [new EmbedBuilder().setTitle('⚠️ DM ainda fechada').setColor('Red')], components: [] });
            }
            return;
        }

        case 'send_thread': {
            const orderId = p[0];
            const order = localConfig.pay_orders.find(o => String(o.id) === String(orderId));
            const plan = localConfig.pay_plans.find(pl => String(pl.id) === String(order?.plan_id));
            const keyRow = plan?.keys.find(k => k.used_by === order?.user_discord_id);
            if (keyRow) await interaction.channel.send({ embeds: [new EmbedBuilder().setTitle('🔑 Chave').setDescription(`\`\`\`${keyRow.key}\`\`\``).setColor('Blue')] });
            await interaction.message.delete().catch(() => {});
            return;
        }
    }
}

async function _generatePix(interaction, client, orderId) {
    const orderIdx = localConfig.pay_orders.findIndex(o => String(o.id) === String(orderId));
    if (orderIdx === -1) return;
    const order = localConfig.pay_orders[orderIdx];
    const plan = localConfig.pay_plans.find(p => String(p.id) === String(order.plan_id));

    const originalContent = interaction.message.content;

    await interaction.editReply({
        content: originalContent,
        embeds: [new EmbedBuilder().setTitle('⏳ Gerando PIX...').setColor('Yellow')],
        components: []
    });

    try {
        const res = await fetch(`${API_BASE}/payment/create`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ amount: plan.price, description: plan.label })
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.message || 'Erro na API');

        const qrB64 = data.qrcode?.imagemQrcode?.split(',')[1] || '';
        order.external_reference = data.transaction.txid;
        setCfg('pay_orders', localConfig.pay_orders);

        const embed = new EmbedBuilder()
            .setTitle('💠 PIX')
            .setDescription(`📋 **Copia e Cola:**\n\`\`\`\n${data.pixCopiaECola}\n\`\`\``)
            .setImage('attachment://qrcode.png')
            .setColor('Green');

        const files = qrB64 ? [{ attachment: Buffer.from(qrB64, 'base64'), name: 'qrcode.png' }] : [];

        const components = [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(buildId('pay','approve', orderId)).setLabel('✅ Aprovar').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(buildId('pay','cancel', orderId)).setLabel('❌ Cancelar').setStyle(ButtonStyle.Danger)
        )];

        await interaction.editReply({ content: originalContent, embeds: [embed], files, components, allowedMentions: { parse: [] } });
    } catch (e) {
        await interaction.editReply({ content: `❌ Erro: ${e.message}`, embeds: [], components: [] });
    }
}

function startPaymentChecker(client) {
    setInterval(async () => {
        const orders = localConfig.pay_orders.filter(o => o.status === 'pending');
        for (const order of orders) {
            if (!order.external_reference || order.external_reference.includes('-')) continue;
            try {
                const res = await fetch(`${API_BASE}/payment/status/${order.external_reference}`, { headers: { 'Authorization': `Bearer ${API_KEY}` } });
                const data = await res.json();
                if (data.transaction?.status === 'approved') {
                    await activatePlan(order, client);
                    order.status = 'approved';
                    setCfg('pay_orders', localConfig.pay_orders);
                }
            } catch (_) {}
        }
    }, 10000);
}

module.exports = { handlePainelDono, handleInteraction, startPaymentChecker };