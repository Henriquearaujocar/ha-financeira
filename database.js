const { Sequelize, DataTypes } = require('sequelize');
const sequelize = new Sequelize({ dialect: 'sqlite', storage: './banco_dados.sqlite', logging: false });

const Devedor = sequelize.define('Devedor', {
  nome: { type: DataTypes.STRING, allowNull: false },
  cpf: { type: DataTypes.STRING, allowNull: false }, // Removido 'unique' para permitir novos empréstimos
  telefone: { type: DataTypes.STRING },
  cep: { type: DataTypes.STRING },
  rua: { type: DataTypes.STRING },
  numero: { type: DataTypes.STRING },
  bairro: { type: DataTypes.STRING },
  valor_emprestado: { type: DataTypes.FLOAT },
  juros_mensal: { type: DataTypes.FLOAT },
  valor_total: { type: DataTypes.FLOAT, defaultValue: 0 },
  data_vencimento: { type: DataTypes.DATEONLY },
  pago: { type: DataTypes.BOOLEAN, defaultValue: false }
});

const Parente = sequelize.define('Parente', {
  nome: { type: DataTypes.STRING },
  telefone: { type: DataTypes.STRING }
});

Devedor.hasMany(Parente, { onDelete: 'CASCADE' });
Parente.belongsTo(Devedor);

sequelize.sync({ alter: true });
module.exports = { Devedor, Parente };